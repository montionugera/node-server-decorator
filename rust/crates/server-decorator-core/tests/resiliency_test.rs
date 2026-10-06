use serde_json::json;
use server_decorator_core::cache::{CacheAdapter, CacheResult, MemoryCacheAdapter};
use server_decorator_core::circuit_breaker::{CircuitBreaker, CircuitBreakerError, CircuitState};
use server_decorator_core::coalesce::BatchLoader;
use server_decorator_core::rate_limit::RateLimiter;
use server_decorator_core::retry::{retry, RetryOptions};
use server_decorator_core::trace::TraceContext;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn test_memory_cache_adapter() {
    let adapter = MemoryCacheAdapter::new();

    // Cache miss
    assert_eq!(adapter.get("key1").await.unwrap(), CacheResult::Miss);

    // Set with TTL
    adapter
        .set("key1", json!({"foo": "bar"}), Duration::from_millis(100))
        .await
        .unwrap();

    // Cache hit
    assert_eq!(
        adapter.get("key1").await.unwrap(),
        CacheResult::Hit(json!({"foo": "bar"}))
    );

    // Allow cache of null as valid value
    adapter
        .set("null_key", json!(null), Duration::from_secs(1))
        .await
        .unwrap();
    assert_eq!(
        adapter.get("null_key").await.unwrap(),
        CacheResult::Hit(json!(null))
    );

    // Wait for TTL expiration
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(adapter.get("key1").await.unwrap(), CacheResult::Miss);
}

#[tokio::test]
async fn test_retry_success_after_failure() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_clone = attempts.clone();

    let opts = RetryOptions {
        max_attempts: 3,
        initial_interval: Duration::from_millis(10),
        max_interval: Duration::from_millis(50),
        multiplier: 2.0,
    };

    let res = retry(&opts, || {
        let att = attempts_clone.clone();
        async move {
            let count = att.fetch_add(1, Ordering::SeqCst);
            if count < 2 {
                Err("temporary failure")
            } else {
                Ok("success")
            }
        }
    })
    .await;

    assert_eq!(res.unwrap(), "success");
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn test_circuit_breaker_transitions() {
    let cb = CircuitBreaker::new(2, Duration::from_millis(100), 2);
    assert_eq!(cb.state().await, CircuitState::Closed);

    // First failure
    let _ = cb.execute(|| async { Err::<(), _>("fail 1") }).await;
    assert_eq!(cb.state().await, CircuitState::Closed);

    // Success in Closed resets failure count
    let _ = cb
        .execute(|| async { Ok::<_, &str>("success in closed") })
        .await;
    assert_eq!(cb.state().await, CircuitState::Closed);

    // Two failures to trigger Open
    let _ = cb.execute(|| async { Err::<(), _>("fail 1 again") }).await;
    let _ = cb.execute(|| async { Err::<(), _>("fail 2") }).await;
    assert_eq!(cb.state().await, CircuitState::Open);

    // While open, fails fast
    let res = cb
        .execute(|| async { Ok::<_, &str>("should not run") })
        .await;
    assert!(matches!(res, Err(CircuitBreakerError::Open)));

    // Wait reset timeout -> transitions to HalfOpen
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(cb.state().await, CircuitState::HalfOpen);

    // Two consecutive successes close it
    let _ = cb.execute(|| async { Ok::<_, &str>("ok 1") }).await;
    assert_eq!(cb.state().await, CircuitState::HalfOpen);
    let _ = cb.execute(|| async { Ok::<_, &str>("ok 2") }).await;
    assert_eq!(cb.state().await, CircuitState::Closed);
}

#[tokio::test]
async fn test_rate_limiter() {
    let limiter = RateLimiter::new(2.0, 10.0); // 2 tokens max, 10 tokens/sec refill

    assert!(limiter.try_acquire(1.0).await);
    assert!(limiter.try_acquire(1.0).await);
    assert!(!limiter.try_acquire(1.0).await);

    // Wait for refill
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(limiter.try_acquire(1.0).await);
}

#[tokio::test]
async fn test_batch_loader_coalescing() {
    let batch_call_count = Arc::new(AtomicUsize::new(0));
    let call_count = batch_call_count.clone();

    let loader = BatchLoader::new(
        move |keys: Vec<String>| {
            let c = call_count.clone();
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                let mut map = HashMap::new();
                for k in keys {
                    map.insert(k.clone(), format!("val_{k}"));
                }
                Ok::<_, String>(map)
            }
        },
        Duration::from_millis(20),
        10,
    );

    // Spawn 5 concurrent loads
    let mut handles = Vec::new();
    for i in 0..5 {
        let l = loader.clone();
        handles.push(tokio::spawn(async move {
            let key = format!("user_{}", i % 2); // user_0 and user_1 with duplicates
            l.load(key).await
        }));
    }

    for h in handles {
        let val = h.await.unwrap().unwrap();
        assert!(val.starts_with("val_user_"));
    }

    // Batch function should have been executed exactly once
    assert_eq!(batch_call_count.load(Ordering::SeqCst), 1);
}

#[test]
fn test_w3c_trace_context() {
    let valid_header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let ctx = TraceContext::parse(valid_header).expect("must parse valid header");
    assert_eq!(ctx.to_header(), valid_header);

    // Invalid version
    assert!(
        TraceContext::parse("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none()
    );
    assert!(
        TraceContext::parse("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").is_none()
    );

    // All-zero trace ID rejected
    assert!(
        TraceContext::parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01").is_none()
    );

    // All-zero span ID rejected
    assert!(
        TraceContext::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01").is_none()
    );
}

#[test]
fn test_trace_context_constructors() {
    let header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let ctx = TraceContext::parse(header).unwrap();
    assert_eq!(ctx.to_header(), header);
    assert_eq!(ctx.version, "00");
    assert_eq!(ctx.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(ctx.parent_id, "00f067aa0ba902b7");
    assert_eq!(ctx.trace_flags, "01");

    // Invalid parts count
    assert!(TraceContext::parse("00-123").is_none());
    // Non-hex characters
    assert!(
        TraceContext::parse("00-4bf92f3577b34da6a3ce929d0e0e473z-00f067aa0ba902b7-01").is_none()
    );
    assert!(
        TraceContext::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902bz-01").is_none()
    );
    assert!(
        TraceContext::parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0z").is_none()
    );
}

#[test]
fn test_queue_message() {
    use server_decorator_core::queue::QueueMessage;
    let msg = QueueMessage::new("user.created", json!({"id": "u1"}));
    assert_eq!(msg.event_name, "user.created");
    assert_eq!(msg.payload, json!({"id": "u1"}));
    assert!(msg.metadata.is_none());

    let mut meta = HashMap::new();
    meta.insert("traceId".to_string(), json!("t123"));
    let msg = msg.with_metadata(meta);
    assert!(msg.metadata.is_some());
}

#[tokio::test]
async fn test_retry_exhaustion() {
    let opts = RetryOptions {
        max_attempts: 2,
        initial_interval: Duration::from_millis(5),
        max_interval: Duration::from_millis(10),
        multiplier: 2.0,
    };
    let res = retry(&opts, || async { Err::<(), _>("always fail") }).await;
    assert!(res.is_err());
}

#[tokio::test]
async fn test_circuit_breaker_half_open_failure() {
    let cb = CircuitBreaker::new(1, Duration::from_millis(50), 2);
    let _ = cb.execute(|| async { Err::<(), _>("fail") }).await;
    assert_eq!(cb.state().await, CircuitState::Open);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(cb.state().await, CircuitState::HalfOpen);
    // Failure in half open immediately re-opens
    let _ = cb
        .execute(|| async { Err::<(), _>("fail in half open") })
        .await;
    assert_eq!(cb.state().await, CircuitState::Open);
}

#[tokio::test]
async fn test_rate_limiter_more_than_capacity() {
    let limiter = RateLimiter::new(5.0, 1.0);
    assert!(!limiter.try_acquire(10.0).await);
}

#[tokio::test]
async fn test_rate_limiter_acquire() {
    let limiter = RateLimiter::new(2.0, 100.0);
    limiter.acquire(1.0).await;
}

#[test]
fn test_retry_options_default() {
    let opts = RetryOptions::default();
    assert_eq!(opts.max_attempts, 3);
}

#[tokio::test]
async fn test_circuit_breaker_inner_error() {
    let cb = CircuitBreaker::new(5, Duration::from_secs(10), 1);
    let res = cb.execute(|| async { Err::<(), _>("my error") }).await;
    match res {
        Err(CircuitBreakerError::Inner(e)) => assert_eq!(e, "my error"),
        _ => panic!("expected inner execution error"),
    }
}

#[tokio::test]
async fn test_batch_loader_error() {
    let loader_fail = BatchLoader::new(
        |_keys: Vec<String>| async move { Err::<HashMap<String, String>, _>("db offline") },
        Duration::from_millis(10),
        5,
    );
    let res = loader_fail.load("k1".into()).await;
    assert_eq!(res.unwrap_err(), "db offline");
}

#[tokio::test]
async fn test_batch_loader_dispatch_immediately() {
    let loader = BatchLoader::new(
        |keys: Vec<String>| async move {
            let mut map = HashMap::new();
            for k in keys {
                map.insert(k.clone(), format!("v_{k}"));
            }
            Ok::<_, String>(map)
        },
        Duration::from_secs(10), // long window
        2,                       // max_batch_size = 2
    );

    let l1 = loader.clone();
    let l2 = loader.clone();
    let h1 = tokio::spawn(async move { l1.load("a".into()).await });
    let h2 = tokio::spawn(async move { l2.load("b".into()).await });

    let res1 = h1.await.unwrap().unwrap();
    let res2 = h2.await.unwrap().unwrap();
    assert_eq!(res1, "v_a");
    assert_eq!(res2, "v_b");
}

#[tokio::test]
async fn test_circuit_breaker_half_open_recovery() {
    let cb = CircuitBreaker::new(1, Duration::from_millis(20), 2);
    let _ = cb.execute(|| async { Err::<(), _>("fail") }).await;
    assert_eq!(cb.state().await, CircuitState::Open);

    // When open, execute immediately returns Err(CircuitBreakerError::Open)
    let open_res = cb.execute(|| async { Ok::<_, &str>("ok") }).await;
    match open_res {
        Err(CircuitBreakerError::Open) => {}
        _ => panic!("expected CircuitBreakerError::Open"),
    }
    assert_eq!(
        format!("{}", CircuitBreakerError::<&str>::Open),
        "circuit breaker is open"
    );

    // Wait for reset timeout to expire
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(cb.state().await, CircuitState::HalfOpen);

    // 1st success in half open -> still half open
    let res1 = cb.execute(|| async { Ok::<_, &str>("first") }).await;
    assert_eq!(res1.unwrap(), "first");
    assert_eq!(cb.state().await, CircuitState::HalfOpen);

    // 2nd success in half open -> closes circuit
    let res2 = cb.execute(|| async { Ok::<_, &str>("second") }).await;
    assert_eq!(res2.unwrap(), "second");
    assert_eq!(cb.state().await, CircuitState::Closed);
}

// Needs Docker: run with `cargo test -p server-decorator-core --features redis`.
#![cfg(feature = "redis")]

use redis::aio::MultiplexedConnection;
use server_decorator_core::{RateLimitError, RedisFixedWindowLimiter};
use std::time::Duration;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

async fn start_redis() -> (ContainerAsync<GenericImage>, redis::Client) {
    let container = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(6379.tcp())
        .with_wait_for(WaitFor::message_on_stdout("Ready to accept connections"))
        .with_label("f040", "1")
        .start()
        .await
        .expect("start redis container");
    let port = container.get_host_port_ipv4(6379).await.unwrap();
    let client = redis::Client::open(format!("redis://127.0.0.1:{port}")).unwrap();
    (container, client)
}

async fn connect(client: &redis::Client) -> MultiplexedConnection {
    client.get_multiplexed_async_connection().await.unwrap()
}

async fn pttl(conn: &mut MultiplexedConnection, key: &str) -> i64 {
    redis::cmd("PTTL").arg(key).query_async(conn).await.unwrap()
}

#[tokio::test]
async fn fixed_window_counts_blocks_and_resets() {
    let (_container, client) = start_redis().await;
    let mut probe = connect(&client).await;
    let window = Duration::from_millis(600);
    let limiter = RedisFixedWindowLimiter::new(connect(&client).await, 3, window);

    let mut first_pttl = 0;
    for i in 1..=3u64 {
        if i == 2 {
            // Real time between hits, so a sliding (re-PEXPIRE per hit) TTL would show up.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let d = limiter.hit("user:1").await.unwrap();
        assert!(d.allowed, "hit {i} allowed");
        assert_eq!(d.limit, 3);
        assert_eq!(d.remaining, 3 - i);
        assert!(d.reset_after > Duration::ZERO && d.reset_after <= window);
        let t = pttl(&mut probe, "ratelimit:user:1").await;
        assert!(t > 0, "PTTL > 0 after hit {i}, got {t}");
        if i == 1 {
            first_pttl = t;
        } else {
            assert!(
                t <= first_pttl - 100,
                "later hits must not extend the window: first {first_pttl}, hit {i} {t}"
            );
            assert!(d.reset_after <= window - Duration::from_millis(100));
        }
    }

    let blocked = limiter.hit("user:1").await.unwrap();
    assert!(!blocked.allowed);
    assert_eq!(blocked.remaining, 0);
    assert!(
        pttl(&mut probe, "ratelimit:user:1").await > 0,
        "PTTL > 0 after blocked hit"
    );

    // Other keys have their own count.
    assert!(limiter.hit("user:2").await.unwrap().allowed);

    tokio::time::sleep(window + Duration::from_millis(100)).await;
    let again = limiter.hit("user:1").await.unwrap();
    assert!(again.allowed, "new window allows again");
    assert_eq!(again.remaining, 2);
    assert!(pttl(&mut probe, "ratelimit:user:1").await > 0);
}

#[tokio::test]
async fn huge_window_still_leaves_a_ttl() {
    let (_container, client) = start_redis().await;
    let mut probe = connect(&client).await;
    let limiter = RedisFixedWindowLimiter::new(connect(&client).await, 5, Duration::MAX);
    assert!(limiter.hit("huge").await.unwrap().allowed);
    assert!(pttl(&mut probe, "ratelimit:huge").await > 0);
}

#[tokio::test]
async fn prefix_is_applied() {
    let (_container, client) = start_redis().await;
    let mut probe = connect(&client).await;
    let limiter = RedisFixedWindowLimiter::new(connect(&client).await, 1, Duration::from_secs(5))
        .with_prefix("rl:");
    limiter.hit("k").await.unwrap();
    assert!(pttl(&mut probe, "rl:k").await > 0);
    assert_eq!(
        pttl(&mut probe, "ratelimit:k").await,
        -2,
        "default prefix unused"
    );
}

#[tokio::test]
async fn clones_on_two_connections_share_one_count() {
    let (_container, client) = start_redis().await;
    let a = RedisFixedWindowLimiter::new(connect(&client).await, 2, Duration::from_secs(5));
    let b = RedisFixedWindowLimiter::new(connect(&client).await, 2, Duration::from_secs(5));
    let a2 = a.clone();
    assert_eq!(a.hit("shared").await.unwrap().remaining, 1);
    assert_eq!(b.hit("shared").await.unwrap().remaining, 0);
    let third = a2.hit("shared").await.unwrap();
    assert!(!third.allowed, "third hit across limiters is blocked");
    assert_eq!(third.remaining, 0);
}

#[tokio::test]
async fn unreachable_redis_fails_closed_by_default_and_open_when_asked() {
    let (container, client) = start_redis().await;
    let closed_conn = connect(&client).await;
    let open_conn = connect(&client).await;
    container.rm().await.unwrap(); // Redis is gone; both connections now point at nothing.

    let window = Duration::from_secs(5);
    let closed = RedisFixedWindowLimiter::new(closed_conn, 7, window);
    assert!(matches!(
        closed.hit("k").await,
        Err(RateLimitError::Redis(_))
    ));

    let open = RedisFixedWindowLimiter::new(open_conn, 7, window).with_fail_open(true);
    let d = open.hit("k").await.unwrap();
    assert!(d.allowed);
    assert_eq!(d.limit, 7);
    assert_eq!(d.remaining, 7);
    assert_eq!(d.reset_after, window);
}

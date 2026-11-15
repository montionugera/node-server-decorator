use std::time::Duration;

// INCR and the TTL in one atomic script, so a key never lives without a TTL. `PTTL < 0` instead of
// `PEXPIRE ... NX` keeps it working on Redis 6; the TTL is only set once, so the window is fixed.
const SCRIPT: &str = r"
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
";

// A 0 ms TTL would delete the key; a TTL PEXPIRE rejects would leave the INCRed key without one.
const MAX_WINDOW: Duration = Duration::from_secs(10 * 365 * 24 * 3600);

/// Fixed-window rate limiter whose counts live in Redis, so every replica shares one limit.
#[derive(Clone)]
pub struct RedisFixedWindowLimiter<C> {
    conn: C,
    limit: u64,
    window: Duration,
    prefix: String,
    fail_open: bool,
    script: redis::Script,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitDecision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    pub reset_after: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum RateLimitError {
    #[error("redis rate limiter: {0}")]
    Redis(#[from] redis::RedisError),
}

impl<C: redis::aio::ConnectionLike + Clone + Send + Sync> RedisFixedWindowLimiter<C> {
    pub fn new(conn: C, limit: u64, window: Duration) -> Self {
        Self {
            conn,
            limit,
            window: window.clamp(Duration::from_millis(1), MAX_WINDOW),
            prefix: "ratelimit:".to_string(),
            fail_open: false,
            script: redis::Script::new(SCRIPT),
        }
    }

    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.prefix = prefix.into();
        self
    }

    pub fn with_fail_open(mut self, fail_open: bool) -> Self {
        self.fail_open = fail_open;
        self
    }

    pub async fn hit(&self, key: &str) -> Result<RateLimitDecision, RateLimitError> {
        let window_ms = self.window.as_millis() as u64; // clamped in new(), always fits
        let mut conn = self.conn.clone();
        let result: redis::RedisResult<(u64, i64)> = self
            .script
            .key(format!("{}{}", self.prefix, key))
            .arg(window_ms)
            .invoke_async(&mut conn)
            .await;
        match result {
            Ok((count, pttl)) => Ok(RateLimitDecision {
                allowed: count <= self.limit,
                limit: self.limit,
                remaining: self.limit.saturating_sub(count),
                reset_after: Duration::from_millis(pttl.max(0) as u64),
            }),
            Err(err) if self.fail_open => {
                tracing::warn!(error = %err, "redis rate limiter failed open");
                Ok(RateLimitDecision {
                    allowed: true,
                    limit: self.limit,
                    remaining: self.limit,
                    reset_after: self.window,
                })
            }
            Err(err) => Err(err.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redis::{aio::ConnectionLike, Arg, Cmd, ErrorKind, Pipeline, RedisFuture, Value};
    use std::sync::{Arc, Mutex};

    // Answers every script call with `reply` (or an IO error) and records the TTL argument sent.
    #[derive(Clone)]
    struct Fake {
        reply: Option<(i64, i64)>,
        sent_ms: Arc<Mutex<Option<u64>>>,
    }

    impl ConnectionLike for Fake {
        fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
            if let Some(Arg::Simple(ms)) = cmd.args_iter().last() {
                *self.sent_ms.lock().unwrap() = std::str::from_utf8(ms).unwrap().parse().ok();
            }
            let r = match self.reply {
                Some((c, t)) => Ok(Value::Array(vec![Value::Int(c), Value::Int(t)])),
                None => Err((ErrorKind::Io, "down").into()),
            };
            Box::pin(async move { r })
        }
        fn req_packed_commands<'a>(
            &'a mut self,
            _: &'a Pipeline,
            _: usize,
            _: usize,
        ) -> RedisFuture<'a, Vec<Value>> {
            unimplemented!()
        }
        fn get_db(&self) -> i64 {
            0
        }
    }

    fn fake(reply: Option<(i64, i64)>) -> Fake {
        Fake {
            reply,
            sent_ms: Arc::default(),
        }
    }

    #[tokio::test]
    async fn maps_count_and_pttl_to_decision() {
        let l = RedisFixedWindowLimiter::new(fake(Some((3, 250))), 2, Duration::from_secs(1));
        let d = l.hit("k").await.unwrap();
        assert_eq!(
            d,
            RateLimitDecision {
                allowed: false,
                limit: 2,
                remaining: 0,
                reset_after: Duration::from_millis(250)
            }
        );
    }

    #[tokio::test]
    async fn window_is_clamped_to_what_pexpire_accepts() {
        for (window, want) in [
            (Duration::ZERO, 1),
            (Duration::MAX, MAX_WINDOW.as_millis() as u64),
            (Duration::from_secs(60), 60_000),
        ] {
            let f = fake(Some((1, 1)));
            RedisFixedWindowLimiter::new(f.clone(), 5, window)
                .hit("k")
                .await
                .unwrap();
            assert_eq!(*f.sent_ms.lock().unwrap(), Some(want), "{window:?}");
        }
    }

    #[tokio::test]
    async fn redis_error_fails_closed_by_default_and_open_when_asked() {
        let w = Duration::from_secs(5);
        let closed = RedisFixedWindowLimiter::new(fake(None), 2, w);
        assert!(matches!(
            closed.hit("k").await,
            Err(RateLimitError::Redis(_))
        ));
        let d = closed.with_fail_open(true).hit("k").await.unwrap();
        assert_eq!(
            d,
            RateLimitDecision {
                allowed: true,
                limit: 2,
                remaining: 2,
                reset_after: w
            }
        );
    }
}

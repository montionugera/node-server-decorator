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
            // A 0 ms TTL would delete the key, so clamp to 1 ms.
            window: window.max(Duration::from_millis(1)),
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
        let window_ms = u64::try_from(self.window.as_millis()).unwrap_or(u64::MAX);
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
                tracing::warn!(error = %err, key, "redis rate limiter failed open");
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

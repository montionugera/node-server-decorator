use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct RateLimiter {
    capacity: f64,
    refill_rate: f64, // tokens per second
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    tokens: f64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(capacity: f64, refill_rate: f64) -> Self {
        Self {
            capacity,
            refill_rate,
            inner: Arc::new(Mutex::new(Inner {
                tokens: capacity,
                last_refill: Instant::now(),
            })),
        }
    }

    pub async fn try_acquire(&self, tokens: f64) -> bool {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        let elapsed = now.duration_since(inner.last_refill).as_secs_f64();
        inner.tokens = (inner.tokens + elapsed * self.refill_rate).min(self.capacity);
        inner.last_refill = now;

        if inner.tokens >= tokens {
            inner.tokens -= tokens;
            true
        } else {
            false
        }
    }

    pub async fn acquire(&self, tokens: f64) {
        loop {
            if self.try_acquire(tokens).await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

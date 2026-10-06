use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Error)]
pub enum CircuitBreakerError<E> {
    #[error("circuit breaker is open")]
    Open,
    #[error("inner execution error: {0}")]
    Inner(#[from] E),
}

struct Inner {
    state: CircuitState,
    failure_count: usize,
    success_count: usize,
    last_state_change: Instant,
}

#[derive(Clone)]
pub struct CircuitBreaker {
    failure_threshold: usize,
    reset_timeout: Duration,
    half_open_success_threshold: usize,
    inner: Arc<RwLock<Inner>>,
}

impl CircuitBreaker {
    pub fn new(
        failure_threshold: usize,
        reset_timeout: Duration,
        half_open_success_threshold: usize,
    ) -> Self {
        Self {
            failure_threshold,
            reset_timeout,
            half_open_success_threshold,
            inner: Arc::new(RwLock::new(Inner {
                state: CircuitState::Closed,
                failure_count: 0,
                success_count: 0,
                last_state_change: Instant::now(),
            })),
        }
    }

    pub async fn state(&self) -> CircuitState {
        let mut inner = self.inner.write().await;
        if inner.state == CircuitState::Open
            && Instant::now().duration_since(inner.last_state_change) >= self.reset_timeout
        {
            inner.state = CircuitState::HalfOpen;
            inner.success_count = 0;
            inner.last_state_change = Instant::now();
        }
        inner.state
    }

    pub async fn execute<F, Fut, T, E>(&self, f: F) -> Result<T, CircuitBreakerError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        let state = self.state().await;
        if state == CircuitState::Open {
            return Err(CircuitBreakerError::Open);
        }

        match f().await {
            Ok(val) => {
                let mut inner = self.inner.write().await;
                if inner.state == CircuitState::HalfOpen {
                    inner.success_count += 1;
                    if inner.success_count >= self.half_open_success_threshold {
                        inner.state = CircuitState::Closed;
                        inner.failure_count = 0;
                        inner.last_state_change = Instant::now();
                    }
                } else if inner.state == CircuitState::Closed {
                    inner.failure_count = 0;
                }
                Ok(val)
            }
            Err(err) => {
                let mut inner = self.inner.write().await;
                inner.failure_count += 1;
                if inner.state == CircuitState::HalfOpen
                    || inner.failure_count >= self.failure_threshold
                {
                    inner.state = CircuitState::Open;
                    inner.last_state_change = Instant::now();
                }
                Err(CircuitBreakerError::Inner(err))
            }
        }
    }
}

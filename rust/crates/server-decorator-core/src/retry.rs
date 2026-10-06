use std::time::Duration;

#[derive(Debug, Clone)]
pub struct RetryOptions {
    pub max_attempts: usize,
    pub initial_interval: Duration,
    pub max_interval: Duration,
    pub multiplier: f64,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_interval: Duration::from_millis(50),
            max_interval: Duration::from_secs(2),
            multiplier: 2.0,
        }
    }
}

pub async fn retry<F, Fut, T, E>(opts: &RetryOptions, mut f: F) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut interval = opts.initial_interval;
    let mut attempt = 0;

    loop {
        attempt += 1;
        match f().await {
            Ok(val) => return Ok(val),
            Err(err) => {
                if attempt >= opts.max_attempts {
                    return Err(err);
                }
                tokio::time::sleep(interval).await;
                interval = std::cmp::min(
                    Duration::from_secs_f64(interval.as_secs_f64() * opts.multiplier),
                    opts.max_interval,
                );
            }
        }
    }
}

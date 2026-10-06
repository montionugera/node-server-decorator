use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::RwLock;

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("cache adapter error: {0}")]
    Adapter(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheResult<T> {
    Hit(T),
    Miss,
}

#[async_trait]
pub trait CacheAdapter: Send + Sync {
    async fn get(&self, key: &str) -> Result<CacheResult<Value>, CacheError>;
    async fn set(&self, key: &str, val: Value, ttl: Duration) -> Result<(), CacheError>;
}

type CacheStorage = Arc<RwLock<HashMap<String, (Value, Option<Instant>)>>>;

#[derive(Clone, Default)]
pub struct MemoryCacheAdapter {
    storage: CacheStorage,
}

impl MemoryCacheAdapter {
    pub fn new() -> Self {
        Self {
            storage: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl CacheAdapter for MemoryCacheAdapter {
    async fn get(&self, key: &str) -> Result<CacheResult<Value>, CacheError> {
        let mut map = self.storage.write().await;
        if let Some((val, expiry)) = map.get(key) {
            if let Some(exp) = expiry {
                if Instant::now() > *exp {
                    map.remove(key);
                    return Ok(CacheResult::Miss);
                }
            }
            return Ok(CacheResult::Hit(val.clone()));
        }
        Ok(CacheResult::Miss)
    }

    async fn set(&self, key: &str, val: Value, ttl: Duration) -> Result<(), CacheError> {
        let mut map = self.storage.write().await;
        let expiry = if ttl.is_zero() {
            None
        } else {
            Some(Instant::now() + ttl)
        };
        map.insert(key.to_string(), (val, expiry));
        Ok(())
    }
}

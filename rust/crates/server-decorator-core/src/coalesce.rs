use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

pub type BatchFn<K, V, E> = Arc<dyn Fn(Vec<K>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<HashMap<K, V>, E>> + Send>> + Send + Sync>;

struct ActiveBatch<K: Eq + Hash + Clone, V: Clone, E: Clone> {
    keys: Vec<K>,
    waiters: HashMap<K, Vec<oneshot::Sender<Result<V, E>>>>,
}

#[derive(Clone)]
pub struct BatchLoader<K: Eq + Hash + Clone + Send + 'static, V: Clone + Send + 'static, E: Clone + Send + 'static> {
    batch_fn: BatchFn<K, V, E>,
    window: Duration,
    max_batch_size: usize,
    active: Arc<Mutex<Option<ActiveBatch<K, V, E>>>>,
}

impl<K: Eq + Hash + Clone + Send + 'static, V: Clone + Send + 'static, E: Clone + Send + 'static> BatchLoader<K, V, E> {
    pub fn new<F, Fut>(batch_fn: F, window: Duration, max_batch_size: usize) -> Self
    where
        F: Fn(Vec<K>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<HashMap<K, V>, E>> + Send + 'static,
    {
        Self {
            batch_fn: Arc::new(move |keys| Box::pin(batch_fn(keys))),
            window,
            max_batch_size,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn load(&self, key: K) -> Result<V, E> {
        let (tx, rx) = oneshot::channel();
        let mut active_guard = self.active.lock().await;

        let should_spawn = active_guard.is_none();
        if active_guard.is_none() {
            *active_guard = Some(ActiveBatch {
                keys: Vec::new(),
                waiters: HashMap::new(),
            });
        }

        let batch = active_guard.as_mut().unwrap();
        if !batch.waiters.contains_key(&key) {
            batch.keys.push(key.clone());
        }
        batch.waiters.entry(key).or_default().push(tx);

        let dispatch_immediately = batch.keys.len() >= self.max_batch_size;
        if dispatch_immediately {
            let ready_batch = active_guard.take().unwrap();
            drop(active_guard);
            let bf = self.batch_fn.clone();
            tokio::spawn(async move {
                Self::execute_batch(bf, ready_batch).await;
            });
        } else if should_spawn {
            let active_clone = self.active.clone();
            let window = self.window;
            let bf = self.batch_fn.clone();
            tokio::spawn(async move {
                tokio::time::sleep(window).await;
                let mut guard = active_clone.lock().await;
                if let Some(ready_batch) = guard.take() {
                    drop(guard);
                    Self::execute_batch(bf, ready_batch).await;
                }
            });
            drop(active_guard);
        } else {
            drop(active_guard);
        }

        match rx.await {
            Ok(res) => res,
            Err(_) => panic!("BatchLoader channel closed unexpectedly"),
        }
    }

    async fn execute_batch(batch_fn: BatchFn<K, V, E>, batch: ActiveBatch<K, V, E>) {
        let result = batch_fn(batch.keys).await;
        match result {
            Ok(map) => {
                for (k, txs) in batch.waiters {
                    if let Some(val) = map.get(&k) {
                        for tx in txs {
                            let _ = tx.send(Ok(val.clone()));
                        }
                    }
                }
            }
            Err(err) => {
                for (_, txs) in batch.waiters {
                    for tx in txs {
                        let _ = tx.send(Err(err.clone()));
                    }
                }
            }
        }
    }
}

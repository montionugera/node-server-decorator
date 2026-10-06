use async_trait::async_trait;
use axum::http::StatusCode;
use axum::Router;
use serde_json::{json, Value};
use server_decorator_axum::{mount_entity_routes, EntityHandler, Problem};
use server_decorator_entity::testing::user_spec;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct InMemoryUserStore {
    users: Arc<RwLock<HashMap<String, Value>>>,
    counter: Arc<AtomicUsize>,
}

impl Default for InMemoryUserStore {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryUserStore {
    pub fn new() -> Self {
        Self {
            users: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(AtomicUsize::new(1)),
        }
    }
}

#[async_trait]
impl EntityHandler for InMemoryUserStore {
    async fn list(&self, params: &HashMap<String, String>) -> Result<Value, Problem> {
        let users = self.users.read().await;
        let mut list: Vec<Value> = users.values().cloned().collect();

        if let Some(status_filter) = params.get("status") {
            list.retain(|u| u.get("status").and_then(|s| s.as_str()) == Some(status_filter));
        }

        let limit: usize = params
            .get("limit")
            .and_then(|l| l.parse().ok())
            .unwrap_or(20);
        let offset: usize = params
            .get("offset")
            .and_then(|o| o.parse().ok())
            .unwrap_or(0);

        let total = list.len();
        let items: Vec<Value> = list.into_iter().skip(offset).take(limit).collect();

        Ok(json!({
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset
        }))
    }

    async fn get(&self, id: &str) -> Result<Value, Problem> {
        let users = self.users.read().await;
        users.get(id).cloned().ok_or_else(|| {
            Problem::new(StatusCode::NOT_FOUND, "User Not Found")
                .with_detail(format!("User {id} does not exist"))
        })
    }

    async fn create(&self, mut payload: Value) -> Result<Value, Problem> {
        let id_num = self.counter.fetch_add(1, Ordering::SeqCst);
        let id = format!("user-{id_num}");

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
            obj.insert("loginCount".to_string(), json!(0));
        }

        let mut users = self.users.write().await;
        users.insert(id.clone(), payload.clone());
        Ok(payload)
    }

    async fn update(&self, id: &str, payload: Value) -> Result<Value, Problem> {
        let mut users = self.users.write().await;
        let user = users
            .get_mut(id)
            .ok_or_else(|| Problem::new(StatusCode::NOT_FOUND, "User Not Found"))?;

        if let (Some(existing_obj), Some(patch_obj)) = (user.as_object_mut(), payload.as_object()) {
            for (k, v) in patch_obj {
                existing_obj.insert(k.clone(), v.clone());
            }
        }

        Ok(user.clone())
    }

    async fn delete(&self, id: &str) -> Result<(), Problem> {
        let mut users = self.users.write().await;
        if users.remove(id).is_some() {
            Ok(())
        } else {
            Err(Problem::new(StatusCode::NOT_FOUND, "User Not Found"))
        }
    }

    async fn action(&self, id: &str, action: &str, _payload: Value) -> Result<Value, Problem> {
        let mut users = self.users.write().await;
        let user = users
            .get_mut(id)
            .ok_or_else(|| Problem::new(StatusCode::NOT_FOUND, "User Not Found"))?;

        if action == "activate" {
            if let Some(obj) = user.as_object_mut() {
                obj.insert("status".to_string(), json!("active"));
            }
            Ok(user.clone())
        } else if action == "ping" {
            Ok(user.clone())
        } else {
            Err(Problem::new(StatusCode::BAD_REQUEST, "Unknown Action"))
        }
    }
}

pub fn create_app() -> Router {
    let spec = user_spec();
    let handler = Arc::new(InMemoryUserStore::new());
    mount_entity_routes(Router::new(), spec, handler)
}

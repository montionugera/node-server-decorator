use crate::problem::{Problem, ValidationProblem};
use async_trait::async_trait;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde_json::Value;
use server_decorator_dto::validate;
use server_decorator_entity::spec::EntitySpec;
use std::collections::HashMap;
use std::sync::Arc;

#[async_trait]
pub trait EntityHandler: Send + Sync + 'static {
    async fn list(&self, params: &HashMap<String, String>) -> Result<Value, Problem>;
    async fn get(&self, id: &str) -> Result<Value, Problem>;
    async fn create(&self, payload: Value) -> Result<Value, Problem>;
    async fn update(&self, id: &str, payload: Value) -> Result<Value, Problem>;
    async fn delete(&self, id: &str) -> Result<(), Problem>;
    async fn action(&self, id: &str, action: &str, payload: Value) -> Result<Value, Problem>;
}

struct AppState<H: EntityHandler> {
    spec: EntitySpec,
    handler: Arc<H>,
}

pub fn mount_entity_routes<H: EntityHandler>(
    router: Router,
    spec: EntitySpec,
    handler: Arc<H>,
) -> Router {
    let base_path = format!("/{}", spec.path);
    let state = Arc::new(AppState {
        spec: spec.clone(),
        handler,
    });

    let mut r = Router::new();

    if spec.ops.iter().any(|op| op == "list") {
        r = r.route(
            &base_path,
            get({
                let state = state.clone();
                move |Query(params): Query<HashMap<String, String>>| {
                    let s = state.clone();
                    async move {
                        match s.handler.list(&params).await {
                            Ok(res) => (StatusCode::OK, Json(res)).into_response(),
                            Err(prob) => prob.into_response(),
                        }
                    }
                }
            }),
        );
    }

    if spec.ops.iter().any(|op| op == "create") {
        r = r.route(
            &base_path,
            post({
                let state = state.clone();
                move |Json(payload): Json<Value>| {
                    let s = state.clone();
                    async move {
                        let (errs, is_valid) = validate(&s.spec, "create", &payload);
                        if !is_valid {
                            return ValidationProblem::new(errs).into_response();
                        }
                        match s.handler.create(payload).await {
                            Ok(res) => (StatusCode::CREATED, Json(res)).into_response(),
                            Err(prob) => prob.into_response(),
                        }
                    }
                }
            }),
        );
    }

    let item_path = format!("{base_path}/:id");

    if spec.ops.iter().any(|op| op == "get") {
        r = r.route(
            &item_path,
            get({
                let state = state.clone();
                move |Path(id): Path<String>| {
                    let s = state.clone();
                    async move {
                        match s.handler.get(&id).await {
                            Ok(res) => (StatusCode::OK, Json(res)).into_response(),
                            Err(prob) => prob.into_response(),
                        }
                    }
                }
            }),
        );
    }

    if spec.ops.iter().any(|op| op == "update") {
        r = r.route(
            &item_path,
            patch({
                let state = state.clone();
                move |Path(id): Path<String>, Json(payload): Json<Value>| {
                    let s = state.clone();
                    async move {
                        let (errs, is_valid) = validate(&s.spec, "update", &payload);
                        if !is_valid {
                            return ValidationProblem::new(errs).into_response();
                        }
                        match s.handler.update(&id, payload).await {
                            Ok(res) => (StatusCode::OK, Json(res)).into_response(),
                            Err(prob) => prob.into_response(),
                        }
                    }
                }
            }),
        );
    }

    if spec.ops.iter().any(|op| op == "delete") {
        r = r.route(
            &item_path,
            delete({
                let state = state.clone();
                move |Path(id): Path<String>| {
                    let s = state.clone();
                    async move {
                        match s.handler.delete(&id).await {
                            Ok(()) => StatusCode::NO_CONTENT.into_response(),
                            Err(prob) => prob.into_response(),
                        }
                    }
                }
            }),
        );
    }

    let action_path = format!("{base_path}/:id/actions/:action");
    r = r.route(
        &action_path,
        post({
            let state = state.clone();
            move |Path((id, action)): Path<(String, String)>, Json(payload): Json<Value>| {
                let s = state.clone();
                async move {
                    let dto_name = format!("action:{action}");
                    let (errs, is_valid) = validate(&s.spec, &dto_name, &payload);
                    if !is_valid {
                        return ValidationProblem::new(errs).into_response();
                    }
                    match s.handler.action(&id, &action, payload).await {
                        Ok(res) => (StatusCode::OK, Json(res)).into_response(),
                        Err(prob) => prob.into_response(),
                    }
                }
            }
        }),
    );

    router.merge(r)
}

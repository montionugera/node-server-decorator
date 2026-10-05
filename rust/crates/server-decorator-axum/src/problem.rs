use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub r#type: String,
    pub title: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

impl Problem {
    pub fn new(status: StatusCode, title: impl Into<String>) -> Self {
        Self {
            r#type: "about:blank".to_string(),
            title: title.into(),
            status: status.as_u16(),
            detail: None,
            instance: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, [("content-type", "application/problem+json")], Json(self)).into_response()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationProblem {
    pub r#type: String,
    pub title: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    pub fields: Vec<String>,
}

impl ValidationProblem {
    pub fn new(fields: Vec<String>) -> Self {
        Self {
            r#type: "about:blank".to_string(),
            title: "Validation Failed".to_string(),
            status: StatusCode::BAD_REQUEST.as_u16(),
            detail: Some("One or more fields failed validation".to_string()),
            instance: None,
            fields,
        }
    }
}

impl IntoResponse for ValidationProblem {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/problem+json")],
            Json(self),
        )
            .into_response()
    }
}

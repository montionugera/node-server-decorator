//! HS256 Bearer JWT extractor (feature `jwt`, off by default).
//!
//! Put a [`JwtConfig`] in axum state and take [`BearerJwt<C>`] in a handler. Every failure is a
//! [`JwtRejection`], which renders as a 401 RFC 9457 problem.

use axum::extract::{FromRef, FromRequestParts};
use axum::http::header::{AUTHORIZATION, WWW_AUTHENTICATE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::de::DeserializeOwned;

use crate::problem::Problem;

/// Verification settings. Cheap to clone (put it in app state).
#[derive(Clone)]
pub struct JwtConfig {
    decoding_key: DecodingKey,
    validation: Validation,
}

impl JwtConfig {
    /// HS256 with a shared secret (the raw bytes of e.g. `JWT_SECRET_KEY`).
    ///
    /// Validation: algorithms = `[HS256]` only; `exp` required and checked; leeway = 0 s;
    /// `nbf` checked when present; no `aud`/`iss` check unless set with the builders below.
    pub fn hs256(secret: impl AsRef<[u8]>) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        // jsonwebtoken rejects any `aud` claim when no audience is configured; we only check it on opt-in.
        validation.validate_aud = false;
        Self {
            decoding_key: DecodingKey::from_secret(secret.as_ref()),
            validation,
        }
    }

    pub fn with_leeway(mut self, secs: u64) -> Self {
        self.validation.leeway = secs;
        self
    }

    pub fn with_issuer(mut self, iss: &[&str]) -> Self {
        self.validation.set_issuer(iss);
        self
    }

    pub fn with_audience(mut self, aud: &[&str]) -> Self {
        self.validation.set_audience(aud);
        self.validation.validate_aud = true;
        self
    }

    /// Verify a raw token (no `Bearer ` prefix). Works outside axum (e.g. a Socket.IO connect
    /// handler). Returns the claims, or the rejection the extractor would return.
    pub fn verify<C: DeserializeOwned>(&self, token: &str) -> Result<C, JwtRejection> {
        jsonwebtoken::decode::<C>(token, &self.decoding_key, &self.validation)
            .map(|data| data.claims)
            .map_err(|e| match e.kind() {
                ErrorKind::ExpiredSignature => JwtRejection::Expired,
                _ => JwtRejection::Invalid,
            })
    }
}

/// Extractor: the decoded claims of a verified Bearer token.
#[derive(Debug, Clone)]
pub struct BearerJwt<C>(pub C);

#[async_trait::async_trait]
impl<S, C> FromRequestParts<S> for BearerJwt<C>
where
    JwtConfig: FromRef<S>,
    S: Send + Sync,
    C: DeserializeOwned + Send,
{
    type Rejection = JwtRejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or(JwtRejection::Missing)?;
        JwtConfig::from_ref(state).verify(token).map(BearerJwt)
    }
}

/// `Bearer <token>`: scheme matched case-insensitively, one space, one non-empty token.
fn bearer_token(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("Bearer") && !token.is_empty() && !token.contains(' '))
        .then_some(token)
}

/// Why a request was rejected. Every variant maps to 401.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum JwtRejection {
    /// No `Authorization` header, or not `Bearer <token>`.
    #[error("missing bearer token")]
    Missing,
    /// Bad signature/alg/format, missing `exp`, wrong claims shape, `nbf`/`iss`/`aud` failure.
    #[error("invalid token")]
    Invalid,
    /// The token's `exp` has passed.
    #[error("token expired")]
    Expired,
}

impl IntoResponse for JwtRejection {
    fn into_response(self) -> Response {
        let mut res = Problem::new(StatusCode::UNAUTHORIZED, "Unauthorized")
            .with_detail(self.to_string())
            .into_response();
        res.headers_mut()
            .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{HeaderMap, Request};
    use axum::routing::get;
    use axum::{Json, Router};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    const SECRET: &str = "test-secret";

    /// message-svc's claims shape: `id` may be a number or a UUID string.
    #[derive(Debug, Deserialize)]
    struct Claims {
        #[allow(dead_code)]
        iat: Option<i64>,
        #[allow(dead_code)]
        exp: i64,
        id: Value,
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn mint(alg: Algorithm, secret: &str, claims: Value) -> String {
        encode(
            &Header::new(alg),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    fn valid(id: Value) -> String {
        mint(
            Algorithm::HS256,
            SECRET,
            json!({"iat": now(), "exp": now() + 3600, "id": id}),
        )
    }

    async fn me(BearerJwt(c): BearerJwt<Claims>) -> Json<Value> {
        Json(c.id)
    }

    fn app() -> Router {
        Router::new()
            .route("/me", get(me))
            .with_state(JwtConfig::hs256(SECRET))
    }

    async fn call(app: Router, auth: Option<&str>) -> (StatusCode, HeaderMap, Value) {
        let mut req = Request::get("/me");
        if let Some(a) = auth {
            req = req.header(AUTHORIZATION, a);
        }
        let res = app.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&bytes).unwrap(),
        )
    }

    async fn assert_401(auth: Option<&str>, detail: &str) {
        let (status, headers, body) = call(app(), auth).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers["content-type"], "application/problem+json");
        assert_eq!(headers["www-authenticate"], "Bearer");
        assert_eq!(
            body,
            json!({"type":"about:blank","title":"Unauthorized","status":401,"detail":detail})
        );
    }

    #[tokio::test]
    async fn valid_token_yields_claims_numeric_id() {
        let (status, _, body) = call(app(), Some(&format!("Bearer {}", valid(json!(42))))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!(42));
    }

    #[tokio::test]
    async fn valid_token_yields_claims_uuid_id() {
        let uuid = "6f1c2c1e-6a5b-4a39-9a51-3f4d1b2c7e10";
        let (status, _, body) = call(app(), Some(&format!("Bearer {}", valid(json!(uuid))))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!(uuid));
    }

    #[tokio::test]
    async fn lowercase_scheme_accepted() {
        let (status, _, _) = call(app(), Some(&format!("bearer {}", valid(json!(1))))).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_header_is_missing() {
        assert_401(None, "missing bearer token").await;
    }

    #[tokio::test]
    async fn wrong_scheme_is_missing() {
        assert_401(Some("Basic xyz"), "missing bearer token").await;
    }

    #[tokio::test]
    async fn empty_token_is_missing() {
        assert_401(Some("Bearer"), "missing bearer token").await;
        assert_401(Some("Bearer "), "missing bearer token").await;
    }

    #[tokio::test]
    async fn bad_signature_is_invalid() {
        let tok = mint(
            Algorithm::HS256,
            "other-secret",
            json!({"exp": now() + 3600, "id": 1}),
        );
        assert_401(Some(&format!("Bearer {tok}")), "invalid token").await;
    }

    #[tokio::test]
    async fn garbage_token_is_invalid() {
        assert_401(Some("Bearer not.a.jwt"), "invalid token").await;
    }

    #[tokio::test]
    async fn missing_exp_is_invalid() {
        let tok = mint(Algorithm::HS256, SECRET, json!({"id": 1}));
        assert_401(Some(&format!("Bearer {tok}")), "invalid token").await;
    }

    #[tokio::test]
    async fn expired_token_is_expired() {
        let tok = mint(Algorithm::HS256, SECRET, json!({"exp": now() - 1, "id": 1}));
        assert_401(Some(&format!("Bearer {tok}")), "token expired").await;
    }

    #[tokio::test]
    async fn wrong_alg_is_invalid() {
        let tok = mint(
            Algorithm::HS512,
            SECRET,
            json!({"exp": now() + 3600, "id": 1}),
        );
        assert_401(Some(&format!("Bearer {tok}")), "invalid token").await;
    }

    #[tokio::test]
    async fn wrong_claims_shape_is_invalid() {
        let tok = mint(Algorithm::HS256, SECRET, json!({"exp": now() + 3600}));
        assert_401(Some(&format!("Bearer {tok}")), "invalid token").await;
    }

    #[test]
    fn verify_works_without_a_request() {
        let cfg = JwtConfig::hs256(SECRET);
        let c: Claims = cfg.verify(&valid(json!(7))).unwrap();
        assert_eq!(c.id, json!(7));
        assert_eq!(
            cfg.verify::<Claims>("nope").unwrap_err(),
            JwtRejection::Invalid
        );
    }

    #[test]
    fn audience_and_issuer_are_opt_in() {
        let tok = mint(
            Algorithm::HS256,
            SECRET,
            json!({"exp": now() + 3600, "id": 1, "aud": "a", "iss": "i"}),
        );
        assert!(JwtConfig::hs256(SECRET).verify::<Claims>(&tok).is_ok());
        let strict = JwtConfig::hs256(SECRET).with_audience(&["b"]);
        assert_eq!(
            strict.verify::<Claims>(&tok).unwrap_err(),
            JwtRejection::Invalid
        );
        let strict = JwtConfig::hs256(SECRET).with_issuer(&["x"]);
        assert_eq!(
            strict.verify::<Claims>(&tok).unwrap_err(),
            JwtRejection::Invalid
        );
        let ok = JwtConfig::hs256(SECRET)
            .with_audience(&["a"])
            .with_issuer(&["i"]);
        assert!(ok.verify::<Claims>(&tok).is_ok());
    }

    #[test]
    fn leeway_accepts_recently_expired() {
        let tok = mint(Algorithm::HS256, SECRET, json!({"exp": now() - 5, "id": 1}));
        let cfg = JwtConfig::hs256(SECRET).with_leeway(60);
        assert!(cfg.verify::<Claims>(&tok).is_ok());
    }

    #[derive(Clone)]
    struct AppState {
        jwt: JwtConfig,
    }

    impl FromRef<AppState> for JwtConfig {
        fn from_ref(s: &AppState) -> Self {
            s.jwt.clone()
        }
    }

    #[tokio::test]
    async fn app_state_with_manual_from_ref() {
        let app = Router::new().route("/me", get(me)).with_state(AppState {
            jwt: JwtConfig::hs256(SECRET),
        });
        let (status, _, body) = call(app, Some(&format!("Bearer {}", valid(json!(9))))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!(9));
    }
}

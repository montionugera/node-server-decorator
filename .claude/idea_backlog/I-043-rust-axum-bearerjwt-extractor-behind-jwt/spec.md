---
title: "Rust axum BearerJwt extractor behind jwt feature"
id: I-043
status: idea
---

# Rust axum BearerJwt extractor behind jwt feature

## Goal

Add an off-by-default `jwt` cargo feature to `server-decorator-axum`. It ships a typed
`BearerJwt<C>` axum extractor. The extractor reads `Authorization: Bearer <token>`, verifies an
HS256 JWT against a secret held in axum state, and gives the handler the decoded claims `C`.
Failures become 401 RFC 9457 problems built on the crate's existing `Problem`. The change is
additive (R1): the default feature set and every existing public item stay unchanged.

## Problem

message-svc F-002 (Rust rewrite, P1a) needs HS256 Bearer auth for `GET /auth/me` and the
upload/messages routes. Without this, every axum service hand-rolls the same ~60 lines of header
parsing, `jsonwebtoken` setup and 401 mapping. The F-002 spec says Core pieces that other
services also need go upstream here, behind an off-by-default feature, and are not forked into
the service.

## Why now

F-002 P0b confirmed that axum 0.7.9 resolves with socketioxide 0.18.9, so the extractor can live
in `-axum` (the `-core` fallback is not needed). F-002 P1b (the message-svc-rs skeleton) uses it
through a temporary `path =` dependency until F-002 P4b releases the crates.

## API (frozen)

Feature and dependency in `rust/crates/server-decorator-axum/Cargo.toml`:

```toml
[features]
default = []
jwt = ["dep:jsonwebtoken"]

[dependencies]
jsonwebtoken = { version = "9.3", optional = true, default-features = false }
```

`default-features = false` drops only `use_pem` (PEM key parsing, which HS256 does not use).
`ring` is a non-optional dependency in 9.x, so HMAC verification is unaffected. The dependency
is declared in the crate, not in `[workspace.dependencies]`, because only this crate uses it.

Module `server_decorator_axum::jwt` (`src/jwt.rs`), wired into `lib.rs` as:

```rust
#[cfg(feature = "jwt")]
pub mod jwt;
```

It is not glob re-exported at the crate root, so the root namespace stays unchanged. Callers
import `server_decorator_axum::jwt::{BearerJwt, JwtConfig, JwtRejection}`.

```rust
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

/// Verification settings. Cheap to clone (put it in app state).
#[derive(Clone)]
pub struct JwtConfig { /* decoding_key: jsonwebtoken::DecodingKey, validation: jsonwebtoken::Validation */ }

impl JwtConfig {
    /// HS256 with a shared secret (the raw bytes of e.g. JWT_SECRET_KEY).
    /// Validation: algorithms = [HS256] only; `exp` required and checked; leeway = 0 s
    /// (passport-jwt parity: clockTolerance 0); `nbf` checked when present; no `aud`/`iss`
    /// check unless set below.
    pub fn hs256(secret: impl AsRef<[u8]>) -> Self;
    /// Optional tightening, builder style.
    pub fn with_leeway(self, secs: u64) -> Self;
    pub fn with_issuer(self, iss: &[&str]) -> Self;
    pub fn with_audience(self, aud: &[&str]) -> Self;
    /// Verify a raw token (no "Bearer " prefix). Works outside axum (e.g. in a Socket.IO
    /// connect handler). Returns the claims, or the rejection the extractor would return.
    pub fn verify<C: DeserializeOwned>(&self, token: &str) -> Result<C, JwtRejection>;
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
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection>;
}

/// Why a request was rejected. Every variant maps to 401.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum JwtRejection {
    #[error("missing bearer token")] Missing, // no Authorization header, or not "Bearer <token>"
    #[error("invalid token")]        Invalid, // bad signature/alg/format, missing exp, wrong claims shape, nbf/iss/aud failure
    #[error("token expired")]        Expired, // jsonwebtoken ErrorKind::ExpiredSignature
}

impl IntoResponse for JwtRejection {
    // 401, `content-type: application/problem+json`, `www-authenticate: Bearer`,
    // body = Problem::new(StatusCode::UNAUTHORIZED, "Unauthorized").with_detail(self.to_string())
    //   -> {"type":"about:blank","title":"Unauthorized","status":401,"detail":"<variant message>"}
}
```

Rules:

- Config reaches the extractor through axum state: `JwtConfig: FromRef<S>`. A plain
  `Router::with_state(JwtConfig)` works (reflexive `FromRef`). An app state struct uses either
  `#[derive(FromRef)]` (needs axum's `macros` feature; the service decides) or a manual
  `impl FromRef`.
- Header parsing: the `Authorization` value must be scheme `Bearer` (matched case-insensitively),
  one space, and one non-empty token. Anything else, including a non-UTF-8 header, is `Missing`.
- Claims are the caller's type `C`. The crate ships no claims struct. A service whose `id` can be
  a number or a UUID uses `id: serde_json::Value` (message-svc: `struct Claims { iat: Option<i64>,
  exp: i64, id: serde_json::Value }`). A claims-shape deserialize error is `Invalid`.
- Detail strings never echo the token, the secret or the `jsonwebtoken` error text.
- A service that needs a different wire body (message-svc's Nest-shaped `{statusCode,message}`)
  takes `Result<BearerJwt<C>, JwtRejection>` in the handler and maps it. The crate offers no
  pluggable error type.
- HS256 only. RS*/ES*/EdDSA, JWKS fetching and key rotation are out of scope.

Parity: there is no Go/TS/Python/Nim twin, because no lane verifies JWTs today. Go's `go/http`
takes a pluggable `ScopeExtractor`, and the Node/Python `entity` `security` metadata is IR only.
This feature changes no contract, IR, fixture or OpenAPI output, so `check-entity-parity.sh` and
`check-openapi-parity.sh` are unaffected. `rust/README.md` §5 says the feature is Rust-only and why.

## Acceptance criteria

Run from the claimed feature worktree, after `cd rust`:

- [ ] 1. `cargo test -p server-decorator-axum --features jwt` passes and covers these cases:
  - a valid HS256 token returns 200 and the claims;
  - a numeric `id` and a UUID-string `id` (`serde_json::Value`) are both accepted;
  - a missing header, `Basic xyz`, and `Bearer` with no token each return 401 `Missing`;
  - lowercase `bearer <tok>` is accepted;
  - a bad signature returns 401 `Invalid`;
  - a token without `exp` returns 401 `Invalid`;
  - an expired token (exp = now - 1, leeway 0) returns 401 `Expired`;
  - an `alg: HS512` token signed with the same secret returns 401 `Invalid`;
  - a 401 response has `content-type: application/problem+json`, `www-authenticate: Bearer` and
    the body `{"type":"about:blank","title":"Unauthorized","status":401,"detail":"…"}`;
  - `JwtConfig::verify` works without a request;
  - state from a `#[derive(Clone)] struct AppState` with a manual
    `impl FromRef<AppState> for JwtConfig` compiles and works.
- [ ] 2. `cargo test -p server-decorator-axum` (default features) passes, and
  `cargo tree -p server-decorator-axum -e normal | grep -c jsonwebtoken` prints `0`.
- [ ] 3. `cargo clippy -p server-decorator-axum --features jwt --all-targets -- -D warnings` and
  `cargo fmt --check` are clean.
- [ ] 4. `cargo test --workspace` passes (no regression in the other crates or the example).
- [ ] 5. `cargo package -p server-decorator-axum --features jwt --allow-dirty --list` lists
  `src/jwt.rs`, so the module ships in the tarball. Nothing is published.
- [ ] 6. `bash scripts/check-versions.sh` passes (run from the repo root; versions untouched).
- [ ] 7. `rust/README.md` §5 documents the `jwt` feature: the enable line, `JwtConfig::hs256`, a
  `BearerJwt<C>` handler example, the 401 problem body, and the Rust-only parity note.

## Non-goals

- No version bump, CHANGELOG entry, tag, `cargo publish`, or npm/PyPI publish. The release happens
  in F-002 P4b through the normal psrw promote flow.
- No Go/TS/Python/Nim twin and no contract/IR change.
- No asymmetric algorithms, JWKS, token issuing, refresh or revocation.
- No pluggable rejection type and no Nest-shaped error body (the service maps the rejection).
- No `exp - iat > 0` check in the crate. That rule is specific to message-svc, so the service
  enforces it on its own claims type.
- No change to the `default` feature set or to existing public items.

## Sketch

`src/jwt.rs` is about 120 lines, with its tests in the same file (`#[cfg(test)]`, using
`tower::ServiceExt::oneshot` against a small `Router`). The tests mint tokens with
`jsonwebtoken::encode`.

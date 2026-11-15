---
title: "Rust core RedisFixedWindowLimiter behind redis feature"
id: F-040
status: refined
from_idea: I-044
---

# Rust core RedisFixedWindowLimiter behind redis feature

Source: message-svc F-002 spec, phase P4b (owner-approved 2026-11-15, including the release).

## Problem

`server-decorator-core` (Rust) only has the in-process token bucket `RateLimiter`. A service that
runs more than one replica (message-svc-rs runs 2) cannot share a limit across pods, so each pod
allows the full quota. message-svc-rs needs one shared limiter for its REST rate limit (F-002 P5)
and must not fork its own.

## Why now

F-002 P5 builds a tower layer over this limiter. F-002 P4b releases it together with F-039 (`jwt`)
in one node-server-decorator release, so message-svc-rs can drop its path dependency.

## Sketch

New module `rust/crates/server-decorator-core/src/redis_rate_limit.rs`, compiled only with the
new off-by-default cargo feature `redis` (optional dependency `redis = "1"`, tokio async).
The existing `RateLimiter` is untouched.

Frozen public API (re-exported from the crate root under `#[cfg(feature = "redis")]`):

```rust
pub struct RedisFixedWindowLimiter<C> { /* private */ }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitDecision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,          // 0 when blocked
    pub reset_after: Duration,   // time until the window ends
}

#[derive(Debug, thiserror::Error)]
pub enum RateLimitError {
    #[error("redis rate limiter: {0}")]
    Redis(#[from] redis::RedisError),
}

impl<C: redis::aio::ConnectionLike + Clone + Send + Sync> RedisFixedWindowLimiter<C> {
    pub fn new(conn: C, limit: u64, window: Duration) -> Self;
    pub fn with_prefix(self, prefix: impl Into<String>) -> Self;  // default "ratelimit:"
    pub fn with_fail_open(self, fail_open: bool) -> Self;         // default false
    pub async fn hit(&self, key: &str) -> Result<RateLimitDecision, RateLimitError>;
}
```

Behaviour:

- `hit` runs **one** Lua script (`redis::Script`, so EVALSHA with EVAL fallback): `INCR` the key,
  give it the window TTL in the same script when it has none, and return `{count, PTTL}`. A key
  can therefore never exist without a TTL, even if the client dies between commands. The TTL step
  must also work on Redis 6 (no `PEXPIRE ... NX` there), so use a `PTTL < 0` check inside the
  script, which is equivalent because the script is atomic.
- `allowed = count <= limit`; `remaining = limit.saturating_sub(count)`.
- The window is fixed: the TTL is set by the first hit and is not extended by later hits.
- Redis error with `fail_open = false`: `Err(RateLimitError::Redis)`. With `fail_open = true`:
  `Ok` with `allowed = true, remaining = limit, reset_after = window`, and one `tracing::warn!`.
- `window` under 1 ms is clamped to 1 ms (a 0 TTL would delete the key).

Out of scope: sliding window, token bucket on Redis, a tower/axum layer (that lives in the
consumer), Node/Python/Go ports.

## Acceptance criteria

- [ ] 1. `cd rust && cargo test -p server-decorator-core --features redis` passes with Docker
      running, and includes a testcontainers Redis test that asserts `PTTL > 0` after **every**
      hit, that hit `limit + 1` is blocked with `remaining == 0`, and that a new window allows
      again after the TTL expires.
- [ ] 2. A test proves two limiter clones (two connections) share one count for the same key.
- [ ] 3. Fail-open is tested against an unreachable Redis: `with_fail_open(true)` returns
      `allowed == true`; the default returns `Err(RateLimitError::Redis(_))`.
- [ ] 4. Without the feature nothing changes: `cargo test --workspace` passes and
      `cargo tree -p server-decorator-core -e normal` does not list `redis`.
- [ ] 5. `cargo fmt --all -- --check` and
      `cargo clippy --all-targets --all-features -- -D warnings` pass in `rust/`.
- [ ] 6. `.github/workflows/ci-rust.yml` runs the `redis`-feature tests and all-features clippy,
      so the new code is covered in CI.
- [ ] 7. `rust/README.md` documents the feature with a short example;
      `bash scripts/check-versions.sh` still passes.
- [ ] 8. `cargo publish -p server-decorator-core --dry-run --allow-dirty` succeeds (the optional
      dependency packages cleanly).

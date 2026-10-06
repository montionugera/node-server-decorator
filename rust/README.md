# Rust — Complete Feature Suite

The Rust workspace provides a production-grade, 100% contract-compliant implementation of the full `server-decorator` ecosystem for Rust 2021 (Rust 1.80+).

Workspace: `server-decorator` · 100% byte-identical EntitySpec IR & OpenAPI 3.1 · RFC 9457 Problem Details · Axum integration · Tokio async runtime.

---

## Crate Overview

| Crate | Path | Capabilities |
| :--- | :--- | :--- |
| **`server-decorator-entity`** | `rust/crates/server-decorator-entity` | EntitySpec IR declaration, `EntitySpecBuilder` fluent API, canonical JSON encoder, parity testing fixture emitter |
| **`server-decorator-openapi`** | `rust/crates/server-decorator-openapi` | OpenAPI 3.1 document generator with 100% byte-identical parity to contract fixtures |
| **`server-decorator-dto`** | `rust/crates/server-decorator-dto` | Runtime DTO validation engine (`create`, `update`, `read`, `action`) passing all 22 contract test cases |
| **`server-decorator-core`** | `rust/crates/server-decorator-core` | Deterministic cache key algorithm (SHA-256 fallback), `CacheAdapter` async trait, `Retry`, `CircuitBreaker`, `RateLimiter`, Tokio `BatchLoader` coalesce singleflight, W3C `TraceContext`, and `QueueMessage` |
| **`server-decorator-axum`** | `rust/crates/server-decorator-axum` | REST route mounting on Axum (`Router`), automatic DTO validation, and RFC 9457 Problem Details |

---

## 1. Declaring Entities (`server-decorator-entity`)

### Fluent Builder API

```rust
use server_decorator_entity::{
    EntitySpecBuilder, Field, Action, Operation, Pagination, Transport,
};

let user_spec = EntitySpecBuilder::new("User", "users")
    .desc("A registered user account")
    .tags(vec!["identity".into()])
    .transports(vec![Transport::Rest, Transport::Rpc])
    .operations(vec![
        Operation::List,
        Operation::Get,
        Operation::Create,
        Operation::Update,
        Operation::Delete,
    ])
    .pagination(Pagination::Offset)
    .field(Field::string("id").id().readonly())
    .field(Field::string("email").format("email").filterable().desc("Primary contact address"))
    .field(Field::string("name").min(2).max(80))
    .field(Field::string("status").enum_values(vec!["inactive".into(), "active".into(), "banned".into()]).filterable())
    .field(Field::integer("loginCount").min(0).readonly())
    .field(Field::list("tags", Field::string("tags")))
    .field(Field::object("profile", vec![Field::string("bio").max(500).optional()]).optional())
    .field(Field::date_time("birthday").nullable().optional())
    .field(Field::number("score").min(0).optional())
    .field(Field::boolean("active").optional())
    .field(Field::string("secretNote").max(100).writeonly().optional())
    .action(Action::new("activate")
        .desc("Move account back to active")
        .transition("status", "inactive", "active")
        .input(vec![Field::string("reason").max(200).optional()])
    )
    .build()
    .expect("Valid EntitySpec");

let canonical_json = user_spec.to_canonical_json().unwrap();
```

---

## 2. Generating OpenAPI 3.1 Documents (`server-decorator-openapi`)

Generate compliant OpenAPI 3.1 specifications matching Node, Python, Go, and Nim byte-for-byte:

```rust
use server_decorator_openapi::generate_openapi;

let doc_json = generate_openapi(&[user_spec], "1.2.0")
    .expect("OpenAPI 3.1 generation");

println!("{}", doc_json);
```

---

## 3. DTO Validation (`server-decorator-dto`)

Validate payloads against DTO projections (`create`, `update`, `read`, `action:<name>`):

```rust
use server_decorator_dto::{validate_dto, DtoProjection};
use serde_json::json;

let payload = json!({
    "name": "Alice",
    "email": "invalid-email"
});

let result = validate_dto(&user_spec, &DtoProjection::Create, &payload);
if let Err(err) = result {
    // Returns sorted list of invalid fields: ["email"]
    println!("Invalid fields: {:?}", err.invalid_fields);
}
```

---

## 4. Core Resiliency Stack (`server-decorator-core`)

### Deterministic Cache Keys & Cache Adapter
```rust
use server_decorator_core::{compute_cache_key, MemoryCacheAdapter, CacheAdapter};
use serde_json::json;
use std::time::Duration;

let key = compute_cache_key("UserService.Get", &[json!("user-123")]);
let cache = MemoryCacheAdapter::new();

cache.set(&key, &json!({"id": "user-123"}), Duration::from_secs(300)).await.unwrap();
let value = cache.get(&key).await.unwrap();
```

### Rate Limiting & Circuit Breaker
```rust
use server_decorator_core::{RateLimiter, CircuitBreaker, CircuitBreakerConfig};
use std::time::Duration;

// Token-bucket rate limiter: 10 capacity, 5 tokens/sec
let limiter = RateLimiter::new(10, 5.0);
assert!(limiter.acquire(1).await);

// 3-state circuit breaker (Closed -> Open -> HalfOpen)
let cb = CircuitBreaker::new(CircuitBreakerConfig {
    failure_threshold: 5,
    reset_timeout: Duration::from_secs(30),
    success_threshold: 2,
});
```

### Request Coalescing (BatchLoader Singleflight)
```rust
use server_decorator_core::BatchLoader;
use std::time::Duration;

let loader = BatchLoader::new(
    Duration::from_millis(10), // max batch window
    100,                       // max batch size
    |keys: Vec<String>| async move {
        // Fetch batch concurrently once
        keys.into_iter().map(|k| (k.clone(), format!("val_{k}"))).collect()
    },
);

let val = loader.load("key1".to_string()).await.unwrap();
```

---

## 5. Axum HTTP Router Adapter (`server-decorator-axum`)

Mount REST routes directly on an Axum router with automatic DTO validation and RFC 9457 Problem Details:

```rust
use axum::Router;
use server_decorator_axum::{mount_entity_routes, EntityHandler};
use std::sync::Arc;

let app = Router::new();
let app = mount_entity_routes(app, Arc::new(user_spec), Arc::new(my_handler));

// Automatically mounts:
// - GET    /users                  (list with pagination & filter query params)
// - POST   /users                  (validates create DTO, returns 201 or 400 ValidationProblem)
// - GET    /users/{id}             (returns 200 or 404 Problem)
// - PATCH  /users/{id}             (validates update DTO, returns 200 or 400/404 Problem)
// - DELETE /users/{id}             (returns 204 No Content or 404 Problem)
// - POST   /users/{id}/actions/:act(validates action input DTO, returns 200 or 400/404 Problem)
```

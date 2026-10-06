# Rust Lane Gap Analysis & Synthesis

**Status**: Completed Research · OpenUltraCode Intake  
**Target Scope**: `rust/` workspace addition to `node-server-decorator`  
**Parity Target**: Byte-identical parity with `contracts/fixtures/entity-spec.valid-user.json` & `contracts/fixtures/openapi.valid-user.json`  

---

## 1. Executive Summary

`node-server-decorator` is a polyglot microservice framework bridging Node/TypeScript, Python, Go, and Nim. The goal of the Rust lane is to introduce first-class Rust support (`rust/` Cargo workspace) providing:
1. **EntitySpec IR Producer**: Compile-time proc-macro / DSL emitting 100% byte-identical canonical JSON.
2. **OpenAPI 3.1 Generator**: 100% byte-identical OpenAPI 3.1 specification generation.
3. **DTO Runtime Validation Engine**: Strict validation conforming to `contracts/fixtures/entity-spec.cases.json` (22 test cases).
4. **Core Resiliency & Aspect Decorators/Wrappers**: Deterministic cache key algorithm, `CacheAdapter` with `CACHE_MISS` sentinel, `Retry`, `CircuitBreaker`, `RateLimit`, `Coalesce` (DataLoader/singleflight batching), and `DistributedLock`.
5. **Queue Messaging & Event Emission**: `QueueMessage` serialization conforming to `contracts/schemas/queue-message.schema.json` with W3C Trace Context propagation (`contracts/rules/trace-context.md`).
6. **Web / Transport Adapters**: First-class Axum / Tower integration for mounting REST routes and emitting RFC 9457 Problem Details.
7. **End-to-End Reference Project**: A runnable Axum server with unit, integration, and E2E tests achieving **>95% code coverage**.

---

## 2. Cross-Language Architectural Comparison

| Dimension | Node / TypeScript | Python | Go | Nim | Proposed Rust Lane |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Metaprogramming** | Runtime Class Decorator (`@Restful`, `@cache`) | Runtime Class Decorator (`@restful`, `@cache`) | Fluent Builder (`entity.New()`) + Generic Wrappers (`core.Cache[In, Out]`) | Compile-time AST Macro (`macro restful*`) | Attribute Proc-Macro (`#[server_decorator::entity]`, `#[server_decorator::cache]`) + Fluent Builder |
| **Spec Immutability** | `Object.freeze` at runtime | Frozen dict / dataclass | Immutable `Spec` struct | Compile-time `const EntitySpec` | Compile-time `const ENTITY_SPEC` / Static `Spec` |
| **Type Reflection** | Decorator metadata reflection | `inspect.get_annotations` + `typing.get_type_hints` | `go/ast` struct tags | Nim compile-time AST inspection | `syn` + `quote` compile-time AST inspection |
| **Validation Engine** | Zod (`@montionugera/entity-spec-gen-zod`) | Pydantic v2 (`server-decorator-gen-pydantic`) | Custom Dynamic Validator (`go/dto/validate.go`) | Compile-time validation | `serde` + dynamic validator / `validator` crate |
| **OpenAPI Generation** | Modular TS (`paths.ts`, `components.ts`) | Monolithic Python (`gen_openapi/__init__.py`) | Monolithic Go (`go/openapi/openapi.go`) | Monolithic Nim (`gen_openapi.nim`) | High-performance modular Rust (`rust/server-decorator-openapi`) |
| **Async Runtime** | Single-threaded Event Loop (`process.nextTick`) | `asyncio` event loop | Goroutines + Channels | Asyncdispatch | Tokio multi-threaded runtime |
| **Batching / Coalesce** | Event loop tick batching | Asyncio Task Coalescing | Mutex + Channels (`Loader[K, V]`) | Channel / async | Tokio channel + Timer window batcher |
| **Resiliency Stacking** | Method descriptor wrapping | Function wrapper wrapping | Function combinators | Macro wrapping | Tower `Service` / `Layer` or procedural wrapper |

---

## 3. Deep Technical Gaps & Solutions

### 3.1 Gap 1: Metaprogramming & Decorator Semantics
* **The Problem**: Rust lacks runtime function monkey-patching or reflection.
* **The Solution**: 
  - Dual API design:
    1. **High-Ergonomic Proc-Macro**: `#[server_decorator::entity(path = "users", ...)]` and `#[server_decorator::cache(adapter = "...", ttl = 300)]`.
    2. **Low-Level Fluent Builder & Generic Combinator**: `EntityBuilder::new("User", "users")` and `cache_fn(adapter, qualname, ttl, handler)`.
  - Compile-time verification in the proc-macro: Fail compile immediately on reserved names (`model_dump`, `schema`), invalid regex patterns (lookaround/backreference), or empty ops/transports.

### 3.2 Gap 2: Canonical JSON Byte Parity
* **The Problem**: `contracts/rules/entity-spec-canonical.md` requires byte-for-byte exact equality with `contracts/fixtures/entity-spec.valid-user.json` and `contracts/fixtures/openapi.valid-user.json`.
* **The Solution**:
  - Rust's `serde_json` by default serializes maps in arbitrary or insertion order unless sorted.
  - Rust must use `BTreeMap<String, Value>` recursively, with:
    - Zero whitespace separators (`,` and `:`).
    - No escaping of non-ASCII characters.
    - Omit-when-default (nulls/empty strings/empty arrays omitted; boolean flags only present when `true`).
    - CamelCase field name transformation (`login_count` → `loginCount`).

### 3.3 Gap 3: Deterministic Cache Key & Sentinel
* **The Problem**: `contracts/rules/cache-key.md` specifies `qualname(arg1,arg2,k1=v1)` with lexicographically sorted kwargs and SHA-256 fallback if length > 250 bytes.
* **The Solution**:
  - Implement `build_cache_key(qualname: &str, args: &[Value], kwargs: &BTreeMap<String, Value>) -> String`.
  - Define `enum CacheValue<T> { Hit(Option<T>), Miss }` and `CacheAdapter` async trait.

### 3.4 Gap 4: Coalescing / DataLoader
* **The Problem**: Node uses `process.nextTick` for DataLoader. Go uses a mutex with timer window.
* **The Solution**:
  - Implement a Tokio-native `BatchLoader<K, V>` using an mpsc channel, debounce timer window (default 1ms), and maximum batch size (default 100).
  - Support singleflight deduplication so identical concurrent keys share a single future.

### 3.5 Gap 5: Queue Message & W3C Trace Context
* **The Problem**: Queue payloads must validate against `contracts/schemas/queue-message.schema.json` with topic `<env>.<service>.<event>`, injecting W3C traceparent into `metadata`.
* **The Solution**:
  - Implement `QueueMessage<T>` Serde struct with strict tag validation and RFC 3339 timestamps.
  - Implement W3C traceparent parser/injector conforming to `contracts/rules/trace-context.md`.

---

## 4. Ecosystem Comparison with Similar Rust Libraries

| Category | Crate | Overlap | Critical Gap vs `server-decorator` |
| :--- | :--- | :--- | :--- |
| **OpenAPI** | `utoipa` | Generates OpenAPI 3.1 via macros (`#[derive(OpenApi)]`) | Handler-centric doc generator. Does not emit a cross-language EntitySpec IR, does not produce multi-tier DTO validators, and does not wire cross-language event emission. |
| **Full Framework** | `poem-openapi` | Code-first OpenAPI framework with object macros | Tightly coupled to the Poem web framework; does not integrate with polyglot polyrepo contracts or Axum/Tower. |
| **Validation** | `validator` | Field validation annotations on structs | Standalone struct validator; does not know about EntitySpec IR, operations (`create`/`update`/`read`/`action`), or OpenAPI generation. |
| **Caching** | `cached` | Function memoization macro (`#[cached]`) | Does not follow the cross-language deterministic cache key spec (`qualname(args)` / SHA256 > 250B) or the `CACHE_MISS` sentinel convention. |
| **Resiliency** | `tower` | Standard middleware Layer/Service pattern | General-purpose plumbing; requires domain-specific decorators/wrappers for cache, circuit breaker, and entity routing. |
| **Batching** | `dataloader` | Port of Facebook's DataLoader | Good batcher, but requires ergonomic integration with the decorator ecosystem and Axum request extensions. |

---

## 5. Architectural Synthesis

The Rust lane will be structured as a modular Cargo workspace under `rust/`:
- `server-decorator-core`: Cache key, CacheAdapter, Resiliency (Retry, CircuitBreaker, RateLimit, Coalesce), QueueMessage, Trace Context.
- `server-decorator-entity`: EntitySpec IR data types, canonical JSON serializer, fluent builder, and AST parser.
- `server-decorator-openapi`: OpenAPI 3.1 generator with 100% byte-parity.
- `server-decorator-dto`: DTO validation engine conforming to `entity-spec.cases.json`.
- `server-decorator-macros`: Attribute and derive procedural macros (`#[restful]`, `#[cache]`).
- `server-decorator-axum`: Axum router mounting, error problem details (RFC 9457), and middleware.
- `examples/axum-entity-server`: Complete runnable reference implementation with unit, integration, and E2E tests.

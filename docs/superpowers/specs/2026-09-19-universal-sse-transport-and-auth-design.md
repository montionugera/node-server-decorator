# Specification: Universal Server-Sent Events (SSE) Transport & Scoped Auth Middleware

**Date:** 2026-09-19  
**Feature:** F-011  
**Status:** Approved  
**Languages:** Go, TypeScript/Node, Python

---

## 1. Problem Statement

Modern microservice architectures (such as `quant` quantitative trading) have two major operational requirements that must behave identically across languages:
1. **Real-Time Data Streaming (SSE)**: Pushing continuous events (market OHLC ticks, portfolio updates, order state changes) to frontend clients with low latency and reliable reconnects (`Last-Event-ID`). While `contracts/schemas/entity-spec.schema.json` defines `transports: ["rest", "rpc", "sse", "ws"]`, no language currently ships an out-of-the-box SSE transport adapter.
2. **Declarative Scope Authorization Middleware**: While `entity.Spec` defines security schemes and scopes (`spec.Security.Ops[op]` and `spec.Security.Actions[act]`), HTTP adapters in all languages currently leave authorization enforcement to manual boilerplate. Services need standard middleware that enforces declared scopes and returns standardized RFC 9457 `401 Unauthorized` / `403 Forbidden` Problem Details.

---

## 2. Technical Architecture & Invariants

```mermaid
flowchart TD
    subgraph Client
        Browser[Client / Browser EventSource]
    end

    subgraph Server_Runtimes [Polyglot Server Adapters (Go / Node / Python)]
        Mux[HTTP Router / Multiplexer]
        AuthMid[Scope Authorization Middleware]
        DTOVal[DTO Validation Engine]
        SSEBroadcaster[SSE Broadcaster & Event Stream]
    end

    Browser -- "GET /{plural}/{id}/stream (Bearer Token)" --> Mux
    Mux --> AuthMid
    AuthMid -- "Missing / Invalid Token" --> 401[401 Problem Details]
    AuthMid -- "Missing Required Scope" --> 403[403 Problem Details]
    AuthMid -- "Authorized" --> SSEBroadcaster
    SSEBroadcaster -- "text/event-stream (Keep-Alive + ID)" --> Browser
```

### 2.1 Wire Specification for Server-Sent Events (SSE)
- **MIME Type:** `text/event-stream; charset=utf-8`
- **Headers:**
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` (disables reverse-proxy buffering in Nginx/Ingress)
- **Frame Wire Format:**
  ```text
  id: <event-id>\n
  event: <event-name>\n
  data: <json-payload>\n\n
  ```
- **Keep-Alive Heartbeat:** Comments sent at regular intervals:
  ```text
  : ping\n\n
  ```
- **Reconnection (`Last-Event-ID`):** When a client reconnects presenting a `Last-Event-ID` header, the broadcaster replays cached recent events after that ID if buffer history allows.

### 2.2 Declarative Scope Authorization
- **Security Check Sequence:**
  1. Inspect `spec.Security.Ops[op]` or `spec.Security.Actions[act]`.
  2. If operation is not present in `spec.Security`: Endpoint is public. Allow access.
  3. If operation is present with `[]`: Authentication required, no particular scope.
     - If credentials absent/invalid: Return `401 Unauthorized` (RFC 9457 `Problem`).
  4. If operation requires scopes `["scope1", "scope2"]`:
     - If credentials absent/invalid: Return `401 Unauthorized`.
     - If extracted scopes do not contain all required scopes: Return `403 Forbidden` (`Problem` specifying missing scope).

---

## 3. Package Deliverables

### 3.1 Go Ecosystem
- `go/sse`:
  - `type Event[T any] struct { ID string, Event string, Data T, Timestamp int64 }`
  - `type Broadcaster[T any] struct`: Non-blocking fan-out channel registry, client subscribe/unsubscribe, keep-alive heartbeat loop, buffer history for `Last-Event-ID`.
  - `ServeHTTP(w http.ResponseWriter, r *http.Request)` implementing `http.Flusher`.
- `go/http`:
  - `type ScopeExtractor func(r *http.Request) (authenticated bool, scopes []string, err error)`
  - Middleware `WithScopeAuth(spec entity.Spec, extractor ScopeExtractor, next http.Handler) http.Handler`
  - Integrated into `MountRoutes` with optional `ScopeExtractor`.

### 3.2 Node / TypeScript Ecosystem
- `node/packages/core/src/sse`:
  - `SSEBroadcaster<T>` with EventEmitter / subscription registry.
  - Express / standard HTTP streaming handler.
- `node/packages/core/src/middleware`:
  - `scopeAuthMiddleware(spec, extractor)` returning 401/403 RFC 9457 Problem Details.

### 3.3 Python Ecosystem
- `python/packages/core/src/server_decorator/sse`:
  - `AsyncSSEBroadcaster[T]` with `asyncio.Queue` fan-out.
  - Streaming response generator for Starlette/FastAPI.
- `python/packages/core/src/server_decorator/middleware`:
  - `ScopeAuthMiddleware` / FastAPI dependency checking scopes against `entity_spec`.

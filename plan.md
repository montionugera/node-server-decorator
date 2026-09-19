# Implementation Plan - F-011: Universal SSE Transport & Scoped Auth Middleware

**Goal:** Implement real-time Server-Sent Events (SSE) streaming transport and declarative scope-based authorization middleware across Go, Node/TypeScript, and Python.

**Architecture:**
- Real-Time Streaming: Standardized `text/event-stream` with heartbeat ping, non-blocking subscriber queues, and `Last-Event-ID` resume.
- Declarative Auth: Matches `spec.Security` against extracted caller scopes, producing standardized RFC 9457 `401 Unauthorized` and `403 Forbidden` Problem Details across all runtimes.

---

### Task 1: Go SSE Transport Engine (`go/sse`)

**Files:**
- Create: `go/sse/event.go`
- Create: `go/sse/broadcaster.go`
- Create: `go/sse/sse_test.go`

**Interfaces:**
- Produces: `Broadcaster[T]` with `Subscribe()`, `Publish()`, and `ServeHTTP()`.

- [ ] **Step 1: Write unit tests for Go SSE broadcaster**
  Test subscriber connect, event receipt, keep-alive ping emission, non-blocking queue overflow protection, and `Last-Event-ID` replay.
- [ ] **Step 2: Run test to verify it fails**
  Run `CGO_ENABLED=0 go test ./go/sse/...` (fails).
- [ ] **Step 3: Implement `go/sse/event.go` and `go/sse/broadcaster.go`**
  Implement pure standard library `http.Flusher`-based SSE handler with generic types and zero external dependencies.
- [ ] **Step 4: Run tests to verify they pass**
  Run `CGO_ENABLED=0 go test -v ./go/sse/...` (passes).
- [ ] **Step 5: Commit**
  Stage and commit Task 1.

---

### Task 2: Go Scoped Authorization Middleware (`go/http`)

**Files:**
- Modify: `go/http/router.go`
- Create: `go/http/auth.go`
- Create: `go/http/auth_test.go`

**Interfaces:**
- Produces: `type ScopeExtractor func(r *http.Request) (authenticated bool, scopes []string, err error)`
- Produces: `MountRoutesWithAuth(mux *http.ServeMux, spec entity.Spec, handler EntityHandler, auth ScopeExtractor)`

- [ ] **Step 1: Write auth middleware tests in `go/http/auth_test.go`**
  Test public endpoints allow access, protected endpoints without token return 401 Problem Details, and endpoints with missing scopes return 403 Problem Details.
- [ ] **Step 2: Run tests to verify they fail**
  Run `CGO_ENABLED=0 go test ./go/http/...` (fails).
- [ ] **Step 3: Implement `go/http/auth.go`**
  Evaluate `spec.Security.Ops[op]` and `spec.Security.Actions[act]` against caller scopes.
- [ ] **Step 4: Verify all tests pass**
  Run `CGO_ENABLED=0 go test -v ./go/http/...`.
- [ ] **Step 5: Commit**
  Stage and commit Task 2.

---

### Task 3: TypeScript/Node SSE Transport & Auth Middleware

**Files:**
- Create: `node/packages/core/src/sse/broadcaster.ts`
- Create: `node/packages/core/src/sse/broadcaster.spec.ts`
- Create: `node/packages/core/src/middleware/scope-auth.ts`
- Create: `node/packages/core/src/middleware/scope-auth.spec.ts`

- [ ] **Step 1: Write test for Node SSE Broadcaster & Auth Middleware**
- [ ] **Step 2: Implement SSE broadcaster with heartbeat and client registry**
- [ ] **Step 3: Implement scope auth middleware with RFC 9457 Problem Details**
- [ ] **Step 4: Run tests via `pnpm -r test:unit`**
- [ ] **Step 5: Commit**
  Stage and commit Task 3.

---

### Task 4: Python SSE Transport & Auth Middleware

**Files:**
- Create: `python/packages/core/src/server_decorator/sse.py`
- Create: `python/packages/core/src/server_decorator/middleware/auth.py`
- Create: `python/packages/core/tests/unit/test_sse.py`
- Create: `python/packages/core/tests/unit/test_auth_middleware.py`

- [ ] **Step 1: Write pytest test cases for Python SSE & Auth**
- [ ] **Step 2: Implement `AsyncSSEBroadcaster` and scope auth dependency**
- [ ] **Step 3: Run `uv run pytest` and verify passing**
- [ ] **Step 4: Commit**
  Stage and commit Task 4.

---

### Task 5: Documentation & Release Quality Gate

**Files:**
- Modify: `website/src/content/docs/`
- Modify: `scripts/contributor-check.sh`
- Verify full contributor gate and cross-language parity.

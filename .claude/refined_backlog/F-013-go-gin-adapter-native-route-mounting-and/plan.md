# Go Gin adapter: native route mounting and DTO binding tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide first-class Gin framework support for Go via DTO binding tag emission in `go/dto` and an isolated submodule `go/adapter/gin` implementing native route mounting, scope auth middleware, and RFC 9457 error handling with zero external dependencies on root `go.mod`.

**Architecture:** Split the implementation into two layers: (1) Core DTO generator (`go/dto/generate.go`) enhanced with standard library string formatting to emit `binding:"required"`, `binding:"required,<format>"`, and `binding:"omitempty"` tags without external imports; (2) An isolated Go submodule at `go/adapter/gin` with its own `go.mod` that imports `github.com/gin-gonic/gin` and replaces the root module locally, translating OpenAPI/Go 1.22 path formats (`/{id}`) to Gin format (`/:id`) and mounting CRUD and discrete Action handlers with RFC 9457 Problem Details.

**Tech Stack:** Go 1.22+, `github.com/gin-gonic/gin` v1.10.0+ (submodule only), `net/http`, `net/http/httptest`.

**Spec:** `docs/superpowers/specs/2026-09-19-go-gin-adapter-design.md`

## Global Constraints

- Root `go.mod` MUST remain 100% pure standard library with zero external dependencies.
- `github.com/gin-gonic/gin` and any external dependencies MUST reside strictly inside `go/adapter/gin/go.mod`.
- Submodule `go/adapter/gin` MUST be covered by CI and contributor check: `(cd go/adapter/gin && CGO_ENABLED=0 go test ./...)`.
- Polyglot contributor check (`scripts/contributor-check.sh`) MUST pass 7/7 gates without failure.
- Every commit MUST be a new commit; never use `git commit --amend`.
- Go code formatting MUST adhere to `gofmt -w go/`.

---

### Task 1: DTO Validation Tag Emission

**Files:**
- Modify: `go/dto/generate.go:65-95`
- Test: `go/dto/generate_test.go`

**Interfaces:**
- Consumes: `entity.Spec`, `entity.Field`
- Produces: `GenerateGoStructs(spec entity.Spec, packageName string) ([]byte, error)` emitting `binding:"..."` struct tags.

**Deliverables & Steps:**
- [ ] Write unit test in `go/dto/generate_test.go` checking that generated structs have `binding:"required"`, `binding:"required,email"`, and `binding:"omitempty"` tags according to field optionality and format.
- [ ] Run test to verify it fails (`go test ./go/dto`).
- [ ] Update `go/dto/generate.go` to construct `bindingTag` alongside `jsonTag`:
  - If optional (or `forceOptional`): `binding:"omitempty"`
  - If not optional and format is specified (e.g. `email`): `binding:"required,email"`
  - If not optional: `binding:"required"`
  - Note: For boolean and numeric types that are not optional, ensure validator tag semantics match expectations or pointer/value representation.
  - Combine tags: `` `json:"<name>[,omitempty]" binding:"<rules>"` ``.
- [ ] Run test to verify it passes (`go test ./go/dto`).
- [ ] Ensure `go test ./go/...` passes and run `gofmt -w go/`.
- [ ] Commit task: `feat(go/dto): emit gin binding tags in generated structs`.

---

### Task 2: Scaffold `go/adapter/gin` Submodule & Wire CI Verification

**Files:**
- Create: `go/adapter/gin/go.mod`
- Create: `go/adapter/gin/doc.go`
- Modify: `scripts/contributor-check.sh`
- Modify: `.github/workflows/ci-go.yml`

**Interfaces:**
- Consumes: Root module `github.com/montionugera/node-server-decorator/v2`
- Produces: Submodule `github.com/montionugera/node-server-decorator/v2/go/adapter/gin` with local replacement to `../../../`.

**Deliverables & Steps:**
- [ ] Create directory `go/adapter/gin`.
- [ ] Initialize `go/adapter/gin/go.mod`:
  ```go
  module github.com/montionugera/node-server-decorator/v2/go/adapter/gin

  go 1.22

  require (
      github.com/gin-gonic/gin v1.10.0
      github.com/montionugera/node-server-decorator/v2 v2.0.0
  )

  replace github.com/montionugera/node-server-decorator/v2 => ../../../
  ```
- [ ] Run `go mod tidy` inside `go/adapter/gin` to pull Gin dependencies into submodule's `go.sum`.
- [ ] Verify root `go.mod` remains untouched and has 0 external dependencies.
- [ ] Create `doc.go` documenting Gin adapter package usage.
- [ ] Update `scripts/contributor-check.sh` step [4/7] to include testing the submodule:
  `(cd "$ROOT_DIR/go/adapter/gin" && CGO_ENABLED=0 go test ./...)`.
- [ ] Update `.github/workflows/ci-go.yml` to test `go/adapter/gin`:
  `cd go/adapter/gin && go test ./...`.
- [ ] Commit task: `feat(go/adapter/gin): initialize gin adapter submodule and wire ci`.

---

### Task 3: Implement Gin Scope Auth Middleware & RFC 9457 Helpers

**Files:**
- Create: `go/adapter/gin/auth.go`
- Create: `go/adapter/gin/problem.go`
- Test: `go/adapter/gin/auth_test.go`

**Interfaces:**
- Consumes: `httpserver.CheckScopes`, `httpserver.ProblemContentType`, `httpserver.ValidationProblemType`
- Produces:
  - `type ScopeExtractor func(c *gin.Context) (authenticated bool, scopes []string, err error)`
  - `func EnforceScopeAuth(requiredScopes []string, extractor ScopeExtractor) gin.HandlerFunc`
  - `func WriteProblem(c *gin.Context, status int, title, detail string)`
  - `func WriteValidationProblem(c *gin.Context, fields []string)`

**Deliverables & Steps:**
- [ ] Write tests in `go/adapter/gin/auth_test.go` for `EnforceScopeAuth`:
  - When extractor returns unauthenticated or error -> 401 Unauthorized Problem Details, downstream handler is aborted (`c.IsAborted() == true`).
  - When extractor returns missing scopes -> 403 Forbidden Problem Details with missing scope message, downstream handler is aborted (`c.IsAborted() == true`).
  - When extractor returns valid scopes -> calls next handler.
  - When no scopes required -> calls next handler.
  - Check Content-Type header on response is strictly `application/problem+json` (verify no Gin JSON override).
- [ ] Implement `problem.go`: writes RFC 9457 Problem Details using `c.Data(status, ProblemContentType, jsonBytes)` to guarantee Content-Type is preserved without Gin's `application/json; charset=utf-8` override.
- [ ] Implement `auth.go`: `EnforceScopeAuth` using `httpserver.CheckScopes`, calling `WriteProblem` and `c.Abort()` on 401/403.
- [ ] Run `go test ./...` in `go/adapter/gin`.
- [ ] Run `gofmt -w go/adapter/gin`.
- [ ] Commit task: `feat(go/adapter/gin): implement scope auth middleware and RFC 9457 problem writers`.

---

### Task 4: Implement Gin Native Route Mounting

**Files:**
- Create: `go/adapter/gin/router.go`
- Test: `go/adapter/gin/router_test.go`

**Interfaces:**
- Consumes: `entity.Spec`, `httpserver.EntityHandler`, `dto.Validate`
- Produces:
  - `type RouterOption func(*routerConfig)`
  - `func WithAuth(extractor ScopeExtractor) RouterOption`
  - `func MountRoutes(router gin.IRoutes, spec entity.Spec, handler httpserver.EntityHandler, opts ...RouterOption)`

**Deliverables & Steps:**
- [ ] Write comprehensive unit tests in `go/adapter/gin/router_test.go`:
  - Path converter test: `/{id}` -> `/:id`.
  - CRUD operations (`GET /users`, `POST /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id`).
  - Action operations (`POST /users/:id/actions/activate`, `POST /users/:id/actions/ping` as discrete routes with distinct auth scopes).
  - Validation failures emitting RFC 9457 `ValidationProblem` (status 400).
  - Not found handling (status 404).
  - Scope authorization integration on operations and actions.
- [ ] Implement path conversion helper `toGinPath(pathPattern string) string` converting `{param}` to `:param`.
- [ ] Implement `MountRoutes`:
  - Mount `list`: `GET basePath` parsing query params `limit`, `offset`, and filterable fields.
  - Mount `get`: `GET itemPath` retrieving param `c.Param(idField)`.
  - Mount `create`: `POST basePath` binding JSON, running `dto.Validate(spec, "create", body)`, invoking `handler.Create`.
  - Mount `update`: `PATCH itemPath` binding JSON, running `dto.Validate(spec, "update", body)`, invoking `handler.Update`.
  - Mount `delete`: `DELETE itemPath` invoking `handler.Delete`.
  - Mount discrete `actions`: `POST itemPath + "/actions/" + act.Name` validating input, attaching action-specific scope middleware, and invoking `handler.Action`.
  - Attach scope authorization middleware if `spec.Security` defines required scopes for ops/actions.
- [ ] Run `go test -v ./...` in `go/adapter/gin`.
- [ ] Run `gofmt -w go/adapter/gin`.
- [ ] Commit task: `feat(go/adapter/gin): implement native route mounting for gin router`.

---

### Task 5: Documentation & Integration Verification

**Files:**
- Modify: `website/src/content/docs/core/adapters.mdx`
- Verify: `scripts/contributor-check.sh`

**Deliverables & Steps:**
- [ ] Update `website/src/content/docs/core/adapters.mdx` to document the Go Gin adapter under supported adapters and include code examples showing `ginadapter.MountRoutes(r, spec, handler, ginadapter.WithAuth(...))` and generated DTOs with `binding` tags.
- [ ] Run `go test ./...` across root module and `go/adapter/gin`.
- [ ] Run `bash scripts/contributor-check.sh` and ensure all 7 gates pass cleanly (including Starlight docs build).
- [ ] Commit task: `docs(gin): document Go Gin adapter in adapters guide`.

---

## Appendix — audit trail
- 2026-09-19 self-grill-audit: verdict safe-with-fixes. Corrected:
  - CI gate blindness: Added `(cd go/adapter/gin && CGO_ENABLED=0 go test ./...)` to `contributor-check.sh` and `ci-go.yml`.
  - Gin Content-Type override: Replaced `c.Header` + `c.JSON` with `c.Data(status, ProblemContentType, jsonBytes)` in `WriteProblem`.
  - Action route wildcard conflict: Mount discrete literal routes `/:id/actions/<act.Name>` instead of a wildcard.
  - Auth bypass: Added explicit `c.Abort()` on 401/403 in `EnforceScopeAuth`.
  - Starlight docs path: Targeted `website/src/content/docs/core/adapters.mdx` instead of non-existent `docs/transports/gin.mdx`.
  Open: none.

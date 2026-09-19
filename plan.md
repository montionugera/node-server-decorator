# [F-009] Complete Go Feature Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete Go feature suite — OpenAPI 3.1 generator with byte parity, EntitySpec DTO validator/test-runner against `entity-spec.cases.json`, Core functional generic wrappers for caching (`contracts/rules/cache-key.md` and `CACHE_MISS`) and queue emission, AST struct-tag parser, and standard `net/http` REST handler generator.

**Architecture:** Extend the Go lane (`github.com/montionugera/node-server-decorator/v2`) within `go/` using pure Go standard library (zero external dependencies, Go 1.22+). Implement `go/openapi` for OpenAPI 3.1 parity, `go/dto` for validation and code generation, `go/core` for generic caching/queue/tracking wrappers, `go/ast` for struct tag parsing, and `go/http` for REST handler mounting.

**Tech Stack:** Go 1.22+, `encoding/json`, `crypto/sha256`, `go/parser`, `go/ast`, `net/http`.

**Spec:** Derived from `contracts/` specifications (`entity-spec.schema.json`, `queue-message.schema.json`, `cache-key.md`, `cache-adapter.md`, `rest-conventions.md`, `entity-spec.cases.json`, `openapi.valid-user.json`).

## Global Constraints

- Go standard library only — zero third-party dependencies in `go.mod`.
- Keep struct fields in `go/openapi` declared in sorted JSON-name order and use `SetEscapeHTML(false)` so JSON output is 100% byte-identical to `contracts/fixtures/openapi.valid-user.json`.
- Cache key hashing in `go/core` must pass all test cases in `contracts/fixtures/cache-key.examples.json`.
- DTO validation in `go/dto` must pass all test cases in `contracts/fixtures/entity-spec.cases.json`.
- Integrate Go into `scripts/check-openapi-parity.sh` and update `scripts/contributor-check.sh`.

---

### Task 1: OpenAPI 3.1 Document Generator in Go (`go/openapi`)

**Files:**
- Create: `go/openapi/openapi.go`
- Create: `go/openapi/patterns.go`
- Create: `go/openapi/openapi_test.go`
- Create: `go/internal/example/emitopenapi/main.go`
- Modify: `scripts/check-openapi-parity.sh:10-24`

**Interfaces:**
- Consumes: `entity.EntitySpec`, `entity.FieldSpec` from `go/entity`.
- Produces: `func Generate(specs []entity.EntitySpec, version string) ([]byte, error)` emitting byte-identical OpenAPI 3.1 JSON matching `contracts/fixtures/openapi.valid-user.json`.

- [ ] **Step 1: Write the failing OpenAPI parity test**
Write `go/openapi/openapi_test.go` loading `contracts/fixtures/openapi.valid-user.json` and comparing against `openapi.Generate([]entity.EntitySpec{entities.UserSpec}, "1.2.0")`.

- [ ] **Step 2: Run test to verify it fails**
Run `go test ./go/openapi/...` (fails with undefined package/function).

- [ ] **Step 3: Implement `go/openapi/patterns.go` and `go/openapi/openapi.go`**
Port OpenAPI component, path, and schema generation matching `contracts/rules/rest-conventions.md` and `contracts/fixtures/openapi.valid-user.json`. Use sorted JSON struct keys and canonical encoder.

- [ ] **Step 4: Create `go/internal/example/emitopenapi/main.go`**
CLI that runs `openapi.Generate([]entity.EntitySpec{entities.UserSpec}, "1.2.0")` and writes to stdout.

- [ ] **Step 5: Run tests and update `scripts/check-openapi-parity.sh`**
Add `go_out=$(go run ./go/internal/example/emitopenapi)` and assert `[ "$go_out" = "$expected" ]`. Verify script outputs:
`OK: openapi parity (TS == PY == GO == NIM == contract fixture)`.

- [ ] **Step 6: Commit**
Stage and commit Task 1.

- [ ] **Step 7: Phase gate** (rule 7): verify → independent review → refactor → re-verify.

---

### Task 2: EntitySpec DTO Validation and Cases Suite in Go (`go/dto`)

**Files:**
- Create: `go/dto/validate.go`
- Create: `go/dto/cases_test.go`
- Create: `go/cmd/gen-dto/main.go`

**Interfaces:**
- Consumes: `entity.EntitySpec`, `contracts/fixtures/entity-spec.cases.json`.
- Produces: `func Validate(spec entity.EntitySpec, dtoType string, payload map[string]any) ([]string, bool)`.
- Produces: `go/cmd/gen-dto` CLI generating typed Go struct source code.

- [ ] **Step 1: Write test harness loading `entity-spec.cases.json`**
In `go/dto/cases_test.go`, load `contracts/fixtures/entity-spec.cases.json` and assert every case passes `Validate()`.

- [ ] **Step 2: Run test to verify it fails**
Run `go test ./go/dto/...` (fails).

- [ ] **Step 3: Implement `go/dto/validate.go`**
Enforce `create`, `update`, `read`, and action DTO include/exclude rules, type checks, enum checks, min/max, pattern, and RFC 3339 datetime format.

- [ ] **Step 4: Implement Go struct generator CLI (`go/cmd/gen-dto`)**
Generate Go struct code with `json` tags and validation rules from an `entity.EntitySpec`.

- [ ] **Step 5: Verify all cases pass**
Run `go test -v ./go/dto/...`. Ensure 100% case parity.

- [ ] **Step 6: Commit**
Stage and commit Task 2.

- [ ] **Step 7: Phase gate** (rule 7): verify → independent review → refactor → re-verify.

---

### Task 3: Core Decorator & Generic Function Wrappers in Go (`go/core`)

**Files:**
- Create: `go/core/cache_key.go`
- Create: `go/core/cache_key_test.go`
- Create: `go/core/sentinel.go`
- Create: `go/core/cache.go`
- Create: `go/core/emit.go`
- Create: `go/core/tracking.go`
- Create: `go/core/adapters.go`
- Create: `go/core/core_test.go`

**Interfaces:**
- Produces:
  - `BuildCacheKey(qualname string, args []any, kwargs map[string]any) string` matching `contracts/rules/cache-key.md`.
  - `CacheMiss` sentinel.
  - `Cache[In, Out](adapter, ttl, fn)` generic wrapper.
  - `EmitOnSuccess[In, Out](queue, topic, fn)` generic wrapper publishing `contracts/schemas/queue-message.schema.json`.
  - `Tracking[In, Out](tracer, key, fn)` generic wrapper.
  - `InMemoryCacheAdapter` and `InMemoryQueueAdapter`.

- [ ] **Step 1: Write cache key test against `cache-key.examples.json`**
Write `go/core/cache_key_test.go` asserting all golden cases match.

- [ ] **Step 2: Implement `go/core/cache_key.go`**
Canonical sorting, `default=str` serialization, and 250-byte SHA-256 truncation. Verify tests pass.

- [ ] **Step 3: Implement `CacheMiss` sentinel and `Cache[In, Out]` wrapper**
`go/core/sentinel.go` and `go/core/cache.go`.

- [ ] **Step 4: Implement `EmitOnSuccess[In, Out]` wrapper and queue schemas**
Construct envelope with UUID v4, RFC 3339 timestamp, payload, and topic.

- [ ] **Step 5: Implement `Tracking[In, Out]` and in-memory adapters**
Add unit tests in `go/core/core_test.go` demonstrating caching, miss detection, and event emission.

- [ ] **Step 6: Run tests and commit**
`go test -v ./go/core/...` passes. Stage and commit Task 3.

- [ ] **Step 7: Phase gate** (rule 7): verify → independent review → refactor → re-verify.

---

### Task 4: Struct-Tag & AST Entity Parser (`go/ast`)

**Files:**
- Create: `go/entity/ast.go`
- Create: `go/entity/ast_test.go`
- Create: `go/cmd/gen-entity-spec/main.go`

**Interfaces:**
- Consumes: Go source files with structs tagged with `entity:"..."`.
- Produces: `ParseStruct(src string, structName string) (entity.EntitySpec, error)`.

- [ ] **Step 1: Write AST parser tests**
Write `go/entity/ast_test.go` parsing a sample Go struct and asserting the resulting `EntitySpec` matches `UserSpec`.

- [ ] **Step 2: Implement `go/entity/ast.go` using `go/parser` and `go/ast`**
Parse struct field types, tag values (`id`, `format=email`, `min=1`, `max=100`, `enum=a|b`, `readonly`), and build `entity.EntitySpec`.

- [ ] **Step 3: Implement `go/cmd/gen-entity-spec` CLI**
Command-line tool that parses Go files and outputs `entity-spec.<name>.json`.

- [ ] **Step 4: Run tests and commit**
`go test -v ./go/entity/...` passes. Stage and commit Task 4.

- [ ] **Step 5: Phase gate** (rule 7): verify → independent review → refactor → re-verify.

---

### Task 5: HTTP Server Router & Problem Details (`go/http`)

**Files:**
- Create: `go/http/problem.go`
- Create: `go/http/router.go`
- Create: `go/http/http_test.go`

**Interfaces:**
- Consumes: `entity.EntitySpec`, `go/dto`.
- Produces: `func MountRoutes(mux *http.ServeMux, spec entity.EntitySpec, handler EntityHandler)`.

- [ ] **Step 1: Write HTTP handler integration tests**
Test `GET /users`, `POST /users`, `GET /users/{id}`, `PATCH /users/{id}`, `DELETE /users/{id}` and validation errors returning `application/problem+json` (RFC 9457).

- [ ] **Step 2: Implement RFC 9457 Problem Details in `go/http/problem.go`**
Problem and ValidationProblem JSON structures with status, title, detail, instance, fields.

- [ ] **Step 3: Implement `go/http/router.go`**
Mount routes on `*http.ServeMux` using Go 1.22 path patterns (`POST /users`, `GET /users/{id}`).

- [ ] **Step 4: Run tests and commit**
`go test -v ./go/http/...` passes. Stage and commit Task 5.

- [ ] **Step 5: Phase gate** (rule 7): verify → independent review → refactor → re-verify.

---

### Task 6: Documentation Portal Updates & Contributor Gate Integration

**Files:**
- Modify: `website/src/content/docs/getting-started/overview.mdx`
- Modify: `website/src/content/docs/getting-started/quickstart.mdx`
- Modify: `website/src/content/docs/core/cache.mdx`
- Modify: `website/src/content/docs/core/emit-on-success.mdx`
- Modify: `website/src/content/docs/generators/openapi.mdx`
- Modify: `website/src/content/docs/generators/dto-validation.mdx`
- Modify: `scripts/contributor-check.sh`
- Modify: `go/README.md`

- [ ] **Step 1: Update documentation website pages**
Add Go code snippets for Caching, Queue Emission, DTO validation, and OpenAPI generation in Starlight synced tabs.

- [ ] **Step 2: Update `go/README.md`**
Document all new packages (`go/openapi`, `go/dto`, `go/core`, `go/http`, `gen-dto`, `gen-entity-spec`).

- [ ] **Step 3: Run full contributor check**
Run `bash scripts/contributor-check.sh` and ensure all gates (OpenAPI parity, EntitySpec parity, tests, docs build) pass.

- [ ] **Step 4: Commit**
Stage and commit Task 6.

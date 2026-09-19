# Go Gin Adapter: Native Route Mounting & DTO Binding Tags

## Goal
Implement first-class Gin framework support for Go via a zero-dependency struct tag enhancement in `go/dto` and an isolated submodule `go/adapter/gin` providing native Gin route mounting, RFC 9457 problem details, and declarative scope authorization without adding external dependencies to the root `go.mod`.

<div class="callout info">
<strong>Module Isolation Architecture</strong>
The root <code>go.mod</code> remains 100% pure standard library. The Gin integration lives in its own submodule <code>github.com/montionugera/node-server-decorator/v2/go/adapter/gin</code>, allowing Gin users to import it directly while non-Gin users incur zero dependency footprint.
</div>

---

## 1. Architecture Overview

```mermaid
flowchart TD
    subgraph Core Specification
        Spec[EntitySpec IR] --> GenDTO[go/dto: gen-dto]
        GenDTO --> Structs["Go Structs (json + binding tags)"]
    end

    subgraph Standard Library (Zero Dependencies)
        RootMod[Root go.mod] --> HTTPMux[go/http: MountRoutes on *http.ServeMux]
    end

    subgraph Gin Submodule (Isolated Dependency)
        GinMod[go/adapter/gin/go.mod] --> GinMount[MountRoutes on gin.IRoutes]
        GinMount --> PathTrans["Path Converter: /{id} -> /:id"]
        GinMount --> GinHandlers["Native gin.HandlerFunc Handlers"]
        GinMount --> ScopeAuth["Gin Scope Auth Middleware"]
        GinHandlers --> RFC9457["RFC 9457 Problem Details (c.Data preserving content-type)"]
    end
```

---

## 2. Component Specifications

### 2.1 DTO Validation Tag Emission (`go/dto/generate.go`)

- Emits standard Gin validator tags:
  - Required fields in Create/Action DTOs receive `binding:"required"`.
  - Format-specific fields (e.g. email) receive `binding:"required,email"`.
  - Optional fields in Update DTO receive `binding:"omitempty"`.
- Uses only Go standard library AST / string formatting. Root `go.mod` has 0 external dependencies.

### 2.2 Gin Submodule (`go/adapter/gin`)

- **Path Transformation**:
  - Automatically translates Go 1.22 path pattern `/{id}` into Gin path pattern `/:id`.
- **Route Mounting**:
  - `MountRoutes(router gin.IRoutes, spec entity.Spec, handler httpserver.EntityHandler, opts ...Option)`
  - Mounts CRUD endpoints:
    - `list` -> `GET /base`
    - `get` -> `GET /base/:id`
    - `create` -> `POST /base`
    - `update` -> `PATCH /base/:id`
    - `delete` -> `DELETE /base/:id`
  - Mounts discrete Action endpoints (not wildcards, to support discrete per-action scope auth):
    - `POST /base/:id/actions/<actionName>`
- **Error Handling**:
  - Emits RFC 9457 Problem Details using `c.Data(status, ProblemContentType, jsonBytes)` with `application/problem+json` to prevent Gin's `c.JSON` Content-Type override.
- **Scope Authorization Middleware**:
  - Extracts caller scopes using `ScopeExtractor(c *gin.Context) (bool, []string, error)`.
  - Enforces `spec.Security` rules with standard 401/403 Problem Details and invokes `c.Abort()` to block unauthorized downstream execution.

---

## 3. Test Plan & Acceptance Criteria

1. **DTO Unit Tests (`go/dto`)**:
   - Verify `binding:"required"`, `binding:"required,email"`, and `binding:"omitempty"` tags on generated structs.
2. **Gin Router Unit Tests (`go/adapter/gin`)**:
   - Test `GET /users` (list with pagination & filter query params).
   - Test `POST /users` (create with JSON body binding).
   - Test `GET /users/:id` (get with path parameter).
   - Test `PATCH /users/:id` (update partial fields).
   - Test `DELETE /users/:id` (delete entity).
   - Test discrete custom entity actions with individual scopes.
   - Test RFC 9457 Problem Details preserving `application/problem+json` on 404 / 400 / 500 errors.
   - Test scope authorization (public, authenticated, authorized, missing scope with `c.IsAborted()`).
3. **Contributor Checks**:
   - Verify `scripts/contributor-check.sh` includes `(cd go/adapter/gin && CGO_ENABLED=0 go test ./...)` and passes 7/7 gates.

---

## Appendix — audit trail
- 2026-09-19 self-grill-audit: verdict safe-with-fixes. Corrected:
  - Added CI testing for `go/adapter/gin` submodule in `contributor-check.sh` and `ci-go.yml`.
  - Fixed Gin Content-Type override via `c.Data(status, ProblemContentType, jsonBytes)`.
  - Fixed action route wildcard conflict by mounting discrete `/:id/actions/<actionName>` routes.
  - Fixed auth bypass by adding `c.Abort()` in `EnforceScopeAuth`.
  - Updated documentation path to `website/src/content/docs/core/adapters.mdx`.
  Open: none.

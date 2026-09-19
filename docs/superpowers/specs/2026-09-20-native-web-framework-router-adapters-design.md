# Native Web Framework Router Adapters: FastAPI and Express Route Mounting over EntitySpec IR

## Goal
Implement first-class native HTTP framework router adapters for **FastAPI (Python)** and **Express (Node/TypeScript)** that mount type-safe, validated CRUD and Action routes directly from `EntitySpec` IR definitions with RFC 9457 Problem Details and declarative scope authorization.

---

## 1. Architecture & Design Decisions

### 1.1 Dependency Footprint & Workspace Separation
- **Node / TypeScript**:
  - Located in `@montionugera/server-decorator/express` (or exported via `@montionugera/server-decorator/express` / barrel) or `src/adapters/express.ts`.
  - In `node/packages/core`, Express is a devDependency for test suites and an optional peer dependency for runtime consumers (`peerDependenciesMeta: { express: { optional: true } }`), ensuring standard core consumers do not pay an unconditional bundle size penalty.
- **Python**:
  - Located in `server_decorator.adapters.fastapi` (or `server_decorator/adapters/fastapi.py`).
  - FastAPI and HTTPX are optional dependencies under `[project.optional-dependencies] fastapi = ["fastapi>=0.100.0", "httpx>=0.25.0"]` and added to `dev` dependencies for pytest.

### 1.2 Unified EntityHandler Contract
Both adapters delegate CRUD & Action lifecycle execution to an `EntityHandler` contract, providing 100% behavioral parity with Go's `httpserver.EntityHandler`:
- `list(params: { limit: number, offset: number, filters: Record<string, string> }): Promise<{ items: any[], total: number }>`
- `get(id: string): Promise<any>` (returns `null` or throws `NotFoundError`)
- `create(data: Record<string, any>): Promise<any>`
- `update(id: string, data: Record<string, any>): Promise<any>`
- `delete(id: string): Promise<void>`
- `action(id: string, actionName: string, data: Record<string, any>): Promise<any>`

### 1.3 Route Paths & Param Translation
- Translates `spec.path` (e.g. `users`) to `/users`.
- Resolves the identity field (field with `role: "id"` or `"id"`).
- **Express**:
  - `GET /users` (list with `limit`, `offset`, and filterable query params)
  - `GET /users/:id` (get by id)
  - `POST /users` (create entity)
  - `PATCH /users/:id` (partial update)
  - `DELETE /users/:id` (delete entity)
  - `POST /users/:id/actions/:actionName` (discrete action execution per `spec.actions`)
- **FastAPI**:
  - Mounts routes on `APIRouter` with path format `/users/{id}` and `/users/{id}/actions/{action_name}`.

### 1.4 RFC 9457 Problem Details
All validation, authentication, and not-found errors emit `application/problem+json`:
- **400 Validation Error**: `type: "https://server-decorator.dev/errors/validation"`, `fields: string[]`.
- **401 Unauthorized**: `title: "Unauthorized"`, `detail: "authentication required"`.
- **403 Forbidden**: `title: "Forbidden"`, `detail: "missing required scope: <scope>"`.
- **404 Not Found**: `title: "Not Found"`, `detail: "entity with id <id> not found"`.
- **500 Internal Error**: `title: "Internal Server Error"`.

### 1.5 Declarative Scope Authorization
- If `spec.security` defines required scopes for operations or actions:
  - Caller scopes are resolved via a user-provided `ScopeExtractor`.
  - If unauthenticated -> 401 Problem Details.
  - If missing required scope -> 403 Problem Details with `missing required scope: <scope>`.
  - If authorized -> proceeds to route handler.

---

## 2. Detailed Component Specifications

### 2.1 Express Adapter (`node/packages/core/src/adapters/express.ts`)
```typescript
export interface ExpressRouterOptions {
  auth?: ScopeExtractor;
}

export function mountExpressRoutes(
  router: express.Router,
  specOrClass: EntitySpec | Function,
  handler: EntityHandler,
  options?: ExpressRouterOptions
): express.Router;
```
- Accepts either raw `EntitySpec` or `@Restful`-decorated class.
- Validates request bodies against `createSchema` and `updateSchema` from `@montionugera/entity-spec-gen-zod` (or built-in entity-spec validator).
- Returns 400 with `application/problem+json` containing sorted `fields` array on validation failure.
- Returns 201 on create, 204 on delete, 200 on list/get/update/action.

### 2.2 FastAPI Adapter (`python/packages/core/src/server_decorator/adapters/fastapi.py`)
```python
class FastAPIAdapterOptions:
    auth_extractor: ScopeExtractor | None = None

def mount_fastapi_routes(
    router: APIRouter,
    spec_or_class: dict[str, Any] | type,
    handler: EntityHandler,
    options: FastAPIAdapterOptions | None = None,
) -> APIRouter:
```
- Mounts endpoints on FastAPI `APIRouter`.
- Handles JSON request validation, query parameters parsing (`limit`, `offset`, filter keys).
- Emits RFC 9457 Problem Details using FastAPI `Response(content=..., media_type="application/problem+json")` or `JSONResponse`.
- Enforces scope authorization via FastAPI dependency or endpoint wrapper.

---

## 3. Verification & Quality Gates
1. **Node Unit & Integration Tests**:
   - Test Express app with `supertest`: list, get, create, update, delete, action.
   - Test validation errors (400 Problem Details with fields).
   - Test scope authorization (401, 403, 200).
   - Test 404 on missing entity.
2. **Python Unit & Integration Tests**:
   - Test FastAPI app with `httpx.AsyncClient` / `TestClient`.
   - Test CRUD and Action lifecycle.
   - Test validation errors and scope authorization.
3. **Parity Check**:
   - Ensure all 7 contributor checks pass (`bash scripts/contributor-check.sh`).

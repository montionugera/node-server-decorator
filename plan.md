# Implementation Plan: Native Web Framework Router Adapters (FastAPI & Express) (F-017)

## Summary
Implement first-class native HTTP framework router adapters for **FastAPI (Python)** and **Express (Node/TypeScript)** that mount type-safe CRUD and Action routes directly from `EntitySpec` IR definitions with RFC 9457 Problem Details and declarative scope authorization.

---

## Tasks

### Task 1: Express Router Adapter (`node/packages/core`)
**Files:**
- Create: `node/packages/core/src/adapters/express.ts`
- Create: `node/packages/core/src/adapters/express.spec.ts`
- Modify: `node/packages/core/package.json`

**Interfaces:**
- Produces: `EntityHandler` interface in TypeScript:
  ```typescript
  export interface EntityHandler {
    list(params: { limit: number; offset: number; filters: Record<string, string> }): Promise<{ items: any[]; total: number }>;
    get(id: string): Promise<any>;
    create(data: Record<string, any>): Promise<any>;
    update(id: string, data: Record<string, any>): Promise<any>;
    delete(id: string): Promise<void>;
    action?(id: string, actionName: string, data: Record<string, any>): Promise<any>;
  }
  ```
- Produces: `NotFoundError` (`class NotFoundError extends Error { status = 404; }`)
- Produces: `mountExpressRoutes(router, specOrClass, handler, options)`
- Produces: RFC 9457 problem writers: `writeProblem(res, status, title, detail, instance)` and `writeValidationProblem(res, fields, instance)`.

**Steps:**
- [ ] Add `express` as optional peerDependency and add subpath export `"./express"` in `node/packages/core/package.json`.
- [ ] Implement `node/packages/core/src/adapters/express.ts`:
  - Path normalization from `spec.path` to `/${path}` and `/:<idField>` (resolving `f.role === 'id'`, defaulting to `id`).
  - List response envelope parity: `{ items, total, limit, offset }`.
  - Filterable query param parsing, limit/offset bounds (default limit 20, max 100).
  - Standalone entity validation according to spec rules emitting RFC 9457 `application/problem+json` (`validation-error`).
  - NotFoundError detection (`err instanceof NotFoundError || err.status === 404`) returning 404 RFC 9457 Problem Details.
  - Declarative scope authorization with `ScopeExtractor` (returning 401 if unauthenticated, 403 with `missing required scope: <scope>` if missing).
  - Discrete action routes for `/:<idField>/actions/:actionName`.
- [ ] Write unit & integration tests in `express.spec.ts` using `supertest` covering:
  - CRUD operations (GET list with query params and envelope, GET by id, POST create, PATCH update, DELETE).
  - Action execution (POST action with input).
  - 400 ValidationProblem on bad payload.
  - 401 & 403 Scope authorization.
  - 404 NotFound problem.
- [ ] Run `pnpm --filter @montionugera/server-decorator test:unit`.
- [ ] Commit task: `feat(node/core): implement native Express router adapter for EntitySpec IR`.

---

### Task 2: FastAPI Router Adapter (`python/packages/core`)
**Files:**
- Create: `python/packages/core/src/server_decorator/adapters/__init__.py`
- Create: `python/packages/core/src/server_decorator/adapters/fastapi.py`
- Create: `python/packages/core/tests/unit/test_fastapi_adapter.py`
- Modify: `python/packages/core/pyproject.toml`

**Interfaces:**
- Produces: `EntityHandler` protocol/class in Python:
  ```python
  class EntityHandler(Protocol):
      async def list(self, limit: int, offset: int, filters: dict[str, str]) -> tuple[list[Any], int]: ...
      async def get(self, id: str) -> Any: ...
      async def create(self, data: dict[str, Any]) -> Any: ...
      async def update(self, id: str, data: dict[str, Any]) -> Any: ...
      async def delete(self, id: str) -> None: ...
      async def action(self, id: str, action: str, data: dict[str, Any]) -> Any: ...
  ```
- Produces: `NotFoundError` (`class NotFoundError(Exception): status_code = 404`)
- Produces: `mount_fastapi_routes(router: APIRouter, spec_or_class: Any, handler: EntityHandler, options: FastAPIAdapterOptions | None = None) -> APIRouter`

**Steps:**
- [ ] Add `fastapi>=0.100.0` and `httpx>=0.25.0` to `pyproject.toml` optional dependencies under `[project.optional-dependencies]` `fastapi = [...]` and `dev = [...]`.
- [ ] Implement `python/packages/core/src/server_decorator/adapters/fastapi.py`:
  - Path translation to `/{<id_field>}` (resolving `f.role == 'id'`, defaulting to `id`).
  - List response envelope parity: `{"items": items, "total": total, "limit": limit, "offset": offset}`.
  - Route handlers for `list`, `get`, `create`, `update`, `delete`, and `action`.
  - Standalone entity validation according to spec rules emitting RFC 9457 `application/problem+json` (`validation-error`).
  - Scope authorization using `enforce_scope_auth`.
  - RFC 9457 `application/problem+json` responses for 400, 401, 403, 404 (NotFoundError), and 500.
- [ ] Write unit tests in `python/packages/core/tests/unit/test_fastapi_adapter.py` using `httpx.ASGITransport` / `AsyncClient` covering:
  - CRUD operations.
  - Action execution.
  - 400 Validation problem.
  - 401 & 403 Scope authorization.
  - 404 NotFound problem.
- [ ] Run `(cd python && uv run --package server-decorator --extra dev pytest packages/core/tests/unit/test_fastapi_adapter.py)`.
- [ ] Commit task: `feat(python/core): implement native FastAPI router adapter for EntitySpec IR`.

---

### Task 3: Documentation & Contributor Quality Gates
**Files:**
- Modify: `website/src/content/docs/core/adapters.mdx`
- Run: `bash scripts/contributor-check.sh`

**Steps:**
- [ ] Update `website/src/content/docs/core/adapters.mdx` with complete documentation and code tabs for Express, FastAPI, and Gin router mounting.
- [ ] Run full contributor verification (`bash scripts/contributor-check.sh`) ensuring all 7 gates pass cleanly.
- [ ] Commit task: `docs(website): document Express and FastAPI router adapters`.

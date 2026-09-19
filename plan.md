# Reactive Call Coalescing Suite: DataLoader + SingleFlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a polyglot reactive call coalescing suite combining in-flight deduplication (SingleFlight) and micro-tick batching (DataLoader) across Go, Node/TypeScript, and Python with zero external dependencies in core.

**Architecture:** 
1. Go Core: `go/core/coalesce` provides a generic, pure-stdlib `Loader[K comparable, V any]` utilizing standard library channels, mutexes, and timers, with SingleFlight deduplication and detached root context execution with all-detached cancellation tracking.
2. Node/TypeScript Core: `@batchLoad` method decorator in `node/packages/core` that wraps single-item lookups and coalesces concurrent calls on the microtask tick (`process.nextTick` / `queueMicrotask`), with options for in-flight deduplication and optional `AsyncLocalStorage` request-scoped context isolation.
3. Python Core: `@batch_load` async decorator in `python/packages/core` integrating with `asyncio` event loop steps.

**Tech Stack:** Go 1.22+ (stdlib only), TypeScript 5+ / Jest, Python 3.10+ / pytest.

**Spec:** `docs/superpowers/specs/2026-09-19-reactive-call-coalescing-pipeline-design.md`

## Global Constraints

- Root `go.mod` MUST remain 100% pure standard library with zero external dependencies.
- Debounce is strictly prohibited; all batching MUST use fixed-window micro-ticks or event-loop ticks.
- Writes remain strictly explicit (`saveAll` or batch inserts) to preserve ACID transaction boundaries.
- Polyglot contributor check (`scripts/contributor-check.sh`) MUST pass 7/7 gates without failure.
- Every commit MUST be a new commit; never use `git commit --amend`.

---

### Task 1: Pure Go Coalesce Loader (`go/core/coalesce`)

**Files:**
- Create: `go/core/coalesce/loader.go`
- Create: `go/core/coalesce/singleflight.go`
- Create: `go/core/coalesce/loader_test.go`

**Interfaces:**
- Produces: `type BatchFn[K comparable, V any] func(ctx context.Context, keys []K) (map[K]V, error)`
- Produces: `type Config[K comparable, V any] struct { BatchFn BatchFn[K, V]; Window time.Duration; MaxBatchSize int; SingleFlight bool }`
- Produces: `func New[K comparable, V any](cfg Config[K, V]) *Loader[K, V]`
- Produces: `func (l *Loader[K, V]) Load(ctx context.Context, key K) (V, error)`
- Produces: `func (l *Loader[K, V]) LoadMany(ctx context.Context, keys []K) (map[K]V, error)`
- Produces: `func (l *Loader[K, V]) Prime(key K, val V)`

**Deliverables & Steps:**
- [ ] Write unit tests in `loader_test.go`:
  - Test batching 50 concurrent `Load` calls into a single `BatchFn` invocation.
  - Test `SingleFlight` deduplication: 10 concurrent requests for identical key execute `BatchFn` with only 1 unique key.
  - Test context cancellation isolation: cancelling 1 caller's context returns context error to that caller without failing the batch for the remaining 49 callers. Only if all callers cancel does the underlying batch query abort.
  - Test cache priming with `Prime(key, val)`.
- [ ] Implement `singleflight.go`: lightweight concurrency primitive tracking in-flight keys and sharing result channels.
- [ ] Implement `loader.go`: channel-based buffer queue with timer / `maxBatchSize` trigger and fan-out dispatch under detached context tracking.
- [ ] Run `CGO_ENABLED=0 go test -v ./go/core/coalesce/...`.
- [ ] Run `gofmt -w go/`.
- [ ] Commit task: `feat(go/core): implement pure-stdlib coalesce loader and singleflight`.

---

### Task 2: Node/TypeScript Reactive Coalescing Decorator (`@batchLoad`)

**Files:**
- Create: `node/packages/core/src/decorators/batch-load.ts`
- Create: `node/packages/core/src/decorators/batch-load.spec.ts`
- Modify: `node/packages/core/src/index.ts`

**Interfaces:**
- Produces: `@batchLoad(options: BatchLoadOptions)`
- Options: `{ batchMethod?: string; batchFn?: (keys: K[]) => Promise<Map<K, V> | V[]>; windowMs?: number; maxBatchSize?: number; deduplicate?: boolean; contextStorage?: AsyncLocalStorage<any> }`

**Deliverables & Steps:**
- [ ] Write Jest unit tests in `batch-load.spec.ts`:
  - Test multiple concurrent calls to decorated method within the same microtask tick coalesce into a single batch call.
  - Test in-flight deduplication of identical IDs.
  - Test `AsyncLocalStorage` request-scoped context isolation (ensuring batch buffers are scoped per request when context storage is supplied).
  - Test error handling when the batch loader rejects.
  - Test transparent result mapping back to the individual callers.
- [ ] Implement `@batchLoad` in `batch-load.ts` using `queueMicrotask` / `process.nextTick`.
- [ ] Export `@batchLoad` from `node/packages/core/src/index.ts`.
- [ ] Run `(cd node && pnpm --filter @montionugera/server-decorator test:unit)`.
- [ ] Commit task: `feat(node/core): implement @batchLoad decorator with microtask coalescing`.

---

### Task 3: Python Async Batch Coalescing Decorator (`@batch_load`)

**Files:**
- Create: `python/packages/core/src/server_decorator/decorators/coalesce.py`
- Create: `python/packages/core/tests/unit/test_coalesce.py`
- Modify: `python/packages/core/src/server_decorator/decorators/__init__.py`
- Modify: `python/packages/core/src/server_decorator/__init__.py`

**Interfaces:**
- Produces: `@batch_load(batch_fn=None, batch_method=None, max_batch_size=100, window_seconds=0.001)`

**Deliverables & Steps:**
- [ ] Write pytest test cases in `test_coalesce.py`:
  - Concurrent `asyncio.gather` calls coalesced into single batch execution.
  - In-flight deduplication for identical keys.
  - Exception propagation to all callers if batch fails.
- [ ] Implement `coalesce.py` using asyncio event loop queues and `call_soon` / `call_later`.
- [ ] Export `@batch_load` in `__init__.py`.
- [ ] Run `(cd python && uv run --package server-decorator --extra dev pytest packages/core/tests/unit)`.
- [ ] Commit task: `feat(python/core): implement @batch_load async decorator`.

---

### Task 4: Documentation & Contributor Verification

**Files:**
- Create: `website/src/content/docs/core/coalescing.mdx`
- Modify: `website/astro.config.mjs` (register new doc page in sidebar)
- Verify: `scripts/contributor-check.sh`

**Deliverables & Steps:**
- [ ] Add `website/src/content/docs/core/coalescing.mdx` with clear architecture diagrams and polyglot code examples (Go, TypeScript, Python).
- [ ] Register `coalescing` doc page in `website/astro.config.mjs`.
- [ ] Ensure node dependencies are installed: `(cd node && pnpm install)` and `(cd website && pnpm install)`.
- [ ] Run `bash scripts/contributor-check.sh` and verify all 7 gates pass cleanly.
- [ ] Commit task: `docs(core): document reactive call coalescing and batch loading`.

---

## Appendix — audit trail
- 2026-09-19 self-grill-audit: verdict safe-with-fixes. Corrected:
  - De-scoped MGET from v2.3 core plan title & scope (moved multi-tier MGET caching to follow-up stage).
  - Added `AsyncLocalStorage` request-scoped context isolation support to `@batchLoad` to prevent tenant leakage.
  - Defined Go context cancellation isolation: detached root execution with active caller count tracking and all-detached abort.
  - Fixed test runner commands to change into package directories (`cd node`, `cd python`).
  - Flagged pre-installing node/website dependencies in worktree before Gate 7 execution.
  Open: none.

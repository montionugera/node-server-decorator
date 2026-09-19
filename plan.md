# Implementation Plan: Cascading Graph Pre-Fetching & Relational Loader Priming (F-016)

## Summary
Extend the reactive call coalescing subsystem (`coalesce.MultiTierLoader` in Go, `@batchLoad` in Node/TypeScript, `@batch_load` in Python) with declarative cascading graph pre-fetching hooks and cache priming capabilities. When parent entities resolve in a batch, child foreign keys (both scalar 1-to-1 and array 1-to-many) are extracted and pre-fetched or primed asynchronously in the background, eliminating serial waterfall latency in relational graphs without blocking parent queries.

Incorporates all auditor refutations and fixes:
1. Implement `LoadMany(ctx, keys)` on `MultiTierLoader` in Go before implementing `Prefetch`.
2. Ensure eager queue instantiation / instance-bound queue resolution so `method.prime(key, val, instance?)` and `method.prefetch(keys, instance?)` work even before the first read.
3. Automatically configure or enable an active L1 cache on loaders when pre-fetch is configured to prevent in-flight completion eviction before downstream reads.
4. Detach pre-fetch context in Go using `context.WithoutCancel(ctx)` with a dedicated timeout to prevent batch context cancellation from aborting background pre-fetches.
5. Export `PrefetchRule` in public barrel `node/packages/core/src/index.ts`.
6. Batch child pre-fetch keys across all parents before dispatching, avoiding N child lookups.

---

## Tasks

### Task 1: Go Core Graph Pre-fetching & Priming in `coalesce`
**Files:**
- Modify: `go/core/coalesce/multitier.go`
- Modify: `go/core/coalesce/multitier_test.go`

**Interfaces:**
- Produces: `LoadMany(ctx context.Context, keys []K) (map[K]V, error)` on `MultiTierLoader[K, V]`.
- Produces: `Prime(key K, value V)` on `MultiTierLoader[K, V]` to inject loaded entities directly into L1/L2 cache without executing queries.
- Produces: `Prefetch(ctx context.Context, keys []K)` on `MultiTierLoader[K, V]` to trigger background batch loading.
- Produces: `PrefetchHook[V any]` func type:
  ```go
  type PrefetchHook[V any] func(ctx context.Context, items []V)
  ```
- Extends: `MultiTierConfig[K, V]` with:
  ```go
  PrefetchHooks []PrefetchHook[V]
  ```

**Deliverables & Steps:**
- [ ] Implement `LoadMany(ctx context.Context, keys []K) (map[K]V, error)` on `MultiTierLoader[K, V]` with concurrent batch coordination and SingleFlight coalescing.
- [ ] Implement `Prime(key K, val V)` on `MultiTierLoader[K, V]`:
  - Inserts value directly into L1 LRU.
  - If L2Cache is configured and Serialize is provided, asynchronously writes to L2 via `SetMany`.
- [ ] Implement `Prefetch(ctx context.Context, keys []K)` on `MultiTierLoader[K, V]`:
  - Detaches caller context via `context.WithoutCancel(ctx)` with a dedicated background timeout (e.g., 5 seconds).
  - Runs `LoadMany` in a background goroutine, logging or ignoring errors without failing caller.
- [ ] Implement prefetch hook execution in `MultiTierLoader`:
  - When batch DB results (and L1/L2 hits) resolve parent items, execute registered `PrefetchHooks` asynchronously with detached context.
- [ ] Write unit tests in `multitier_test.go`:
  - Verify `LoadMany` fetches multiple keys correctly with L1/L2/L3 tiers.
  - Verify `Prime(key, val)` allows immediate `Load` hit without invoking DB batch function.
  - Verify `Prefetch(ctx, keys)` triggers batch fetch in background and populates cache.
  - Verify parent loader batch resolution automatically invokes registered prefetch hooks for child keys.
  - Verify prefetch errors in background do not fail or delay parent `Load` or `LoadMany`.
- [ ] Run `(cd go && CGO_ENABLED=0 go test -v ./core/coalesce/...)`.
- [ ] Commit task: `feat(go/core): add graph prefetching and cache priming to multitier loader`.

---

### Task 2: Node / TypeScript `@batchLoad` Cascading Pre-fetch Integration
**Files:**
- Modify: `node/packages/core/src/decorators/batch-load.ts`
- Modify: `node/packages/core/src/index.ts`
- Modify: `node/packages/core/src/decorators/batch-load.spec.ts`

**Interfaces:**
- Extends: `BatchLoadOptions<K, V>`:
  ```typescript
  export interface PrefetchRule<P = any, C = any> {
    extract: (parent: P) => C | C[] | null | undefined;
    loader: () => ((key: C) => Promise<any>) | { load: (key: C) => Promise<any>; loadMany?: (keys: C[]) => Promise<any> };
  }

  export interface BatchLoadOptions<K, V> {
    // ... existing options ...
    prefetch?: PrefetchRule<V, any>[];
  }
  ```
- Exports: `PrefetchRule` from `node/packages/core/src/index.ts`.
- Produces: `prime(key: K, value: V, instance?: any)` method attached to decorated function and `BatchQueue`.
- Produces: `prefetch(keys: K[], instance?: any)` method attached to decorated function and `BatchQueue`.

**Deliverables & Steps:**
- [ ] Add `prime(key: K, value: V)` to `BatchQueue`:
  - Sets item in `l1Cache`.
  - If `l2Adapter` exists, saves to L2 via `setMany`.
- [ ] Add `prefetch(keys: K[])` to `BatchQueue`:
  - Calls `load` for each key within the queue window/microtask, ensuring coalesced batch dispatch.
- [ ] Implement `getOrCreateQueue(scopeTarget, this)` helper in `batchLoad` decorator so `method.prime`, `method.prefetch`, and `method.clear` can resolve or initialize the queue for an instance even before any `load` call.
- [ ] Ensure `l1Cache` is activated (defaulting to e.g. 5000 entries / 10s TTL) if `prefetch` rules are specified but `cache.l1` was not explicitly configured, preventing prefetch results from being discarded upon in-flight promise settlement.
- [ ] In `BatchQueue.dispatch()`:
  - After entities resolve (from L2 or L3 DB), execute configured `prefetch` rules.
  - For each rule, extract all child keys across all resolved entities.
  - Flatten arrays, filter out null/undefined, and deduplicate child keys into a batch.
  - Invoke child loader (`childLoader.prefetch(batchKeys)` if available, or `childLoader(key)` in parallel microtask, or `childLoader.load(key)`).
  - Attach `.catch(() => {})` so child pre-fetch errors never reject or delay parent resolution.
- [ ] Write Jest unit tests in `batch-load.spec.ts`:
  - Test `prime(key, value)` populates L1/L2 and subsequent call returns primed value with 0 batch calls.
  - Test `prime` before any lookup call works properly with instance binding.
  - Test 1-to-1 prefetch (`extract: order => order.userId`).
  - Test 1-to-many prefetch (`extract: order => order.itemIds`).
  - Test downstream lookup after prefetch resolves from primed cache with 0 secondary batch calls.
  - Test child prefetch failure does not reject parent query.
- [ ] Run `(cd node && pnpm --filter @montionugera/server-decorator test:unit)`.
- [ ] Commit task: `feat(node/core): add cascading prefetching and priming to @batchLoad`.

---

### Task 3: Python Async `@batch_load` Cascading Pre-fetch Integration
**Files:**
- Modify: `python/packages/core/src/server_decorator/decorators/coalesce.py`
- Modify: `python/packages/core/tests/unit/test_coalesce.py`

**Interfaces:**
- Extends: `@batch_load` parameters:
  ```python
  prefetch: list[dict[str, Any]] | None = None
  ```
  Where each prefetch entry contains:
  `{"extract": Callable[[Parent], ChildKey | list[ChildKey] | None], "loader": Callable[[], LoaderFn]}`
- Produces: `prime(key: Any, value: Any, instance: Any = None)` method on decorated wrapper.
- Produces: `prefetch(keys: list[Any], instance: Any = None)` method on decorated wrapper.

**Deliverables & Steps:**
- [ ] Add `prime(key, value)` and `prefetch(keys)` methods to `BatchQueue`.
- [ ] In `coalesce.py`, ensure `_get_or_create_queue(scope_target, instance)` allows `prime` and `prefetch` to access or initialize the queue ahead of first lookup.
- [ ] If `prefetch` is defined and `l1_max_size == 0`, default `l1_max_size` to 5000 with `l1_ttl_seconds = 10` so pre-fetched child results persist in L1 for downstream reads.
- [ ] In `BatchQueue._dispatch()`, after resolving entities:
  - Run prefetch extraction for each registered prefetch hook across all resolved items (supporting scalar and iterable keys, filtering `None`, deduplicating keys).
  - Launch child lookups via `asyncio.create_task` with error suppression.
- [ ] Write unit tests in `test_coalesce.py`:
  - Test `prime(key, value)` avoids L3 execution.
  - Test 1-to-1 prefetch (`extract: lambda o: o["user_id"]`).
  - Test 1-to-many prefetch (`extract: lambda o: o["item_ids"]`).
  - Test downstream lookup hits primed cache without extra DB calls.
  - Test error resilience in background prefetch task.
- [ ] Run `(cd python && uv run --package server-decorator --extra dev pytest packages/core/tests/unit/test_coalesce.py)`.
- [ ] Commit task: `feat(python/core): add cascading prefetching and priming to @batch_load`.

---

### Task 4: Documentation & Contributor Quality Gates
**Files:**
- Modify: `website/src/content/docs/core/coalescing.mdx`

**Deliverables & Steps:**
- [ ] Document Cascading Graph Pre-fetching and Cache Priming in `coalescing.mdx` with TypeScript, Python, and Go examples.
- [ ] Run full contributor quality gate `bash scripts/contributor-check.sh` and ensure all 7 gates pass cleanly.
- [ ] Commit task: `docs(core): add cascading graph prefetching and priming guide`.
- [ ] Ready to ship feature via `psrw ship`.

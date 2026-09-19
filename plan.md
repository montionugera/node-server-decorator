# Implementation Plan: Multi-Tier Call Coalescing (F-015)

## Summary
Extend the reactive call coalescing subsystem to support a 3-tier read hierarchy (L1 in-memory LRU, L2 distributed Redis MGET, L3 DB batch loader) with SingleFlight deduplication and explicit cache eviction across Go, Node/TypeScript, and Python.

---

## Tasks

### Task 1: Go Core Multi-Tier Coalescing Loader
**Files:**
- Create: `go/core/coalesce/multitier.go`
- Create: `go/core/coalesce/lru.go`
- Create: `go/core/coalesce/multitier_test.go`

**Interfaces:**
- Produces: `MGetCache` interface:
  ```go
  type MGetCache interface {
      MGet(ctx context.Context, keys []string) (map[string][]byte, error)
      SetMany(ctx context.Context, items map[string][]byte, ttl time.Duration) error
      Delete(ctx context.Context, keys ...string) error
  }
  ```
- Produces: `MultiTierLoader[K comparable, V any]` with `Load(ctx, key)`, `LoadMany(ctx, keys)`, `Clear(ctx, key)`, `Close()`.
- Produces: pure Go stdlib bounded thread-safe LRU cache in `go/core/coalesce/lru.go` (doubly-linked list + map with `sync.RWMutex`).

**Deliverables & Steps:**
- [ ] Implement pure stdlib thread-safe LRU cache with TTL in `lru.go`.
- [ ] Implement `MultiTierLoader` in `multitier.go`:
  - Route incoming calls through the micro-window buffer (`batchTimeout`) to collect all concurrent keys.
  - Check L1 (return hits immediately).
  - For L1 misses: if `L2Cache` is configured, call `L2Cache.MGet(ctx, stringKeys)` for all window misses in one bulk operation.
  - Found L2 keys are deserialized and backfilled to L1.
  - For remaining L2 misses: execute `BatchFn(missKeys)` under `SingleFlight`.
  - Found entities are serialized and written to L2 via `SetMany` (pipelined SET with TTL) and stored in L1.
  - Missing entities are stored in L1/L2 with `NegativeTTL` sentinel to defend against cache penetration.
  - `Clear(ctx, key)` purges the key from L1 and calls `L2Cache.Delete(ctx, key)`.
- [ ] Write unit tests in `multitier_test.go`:
  - Test L1 hit returns without querying L2 or L3.
  - Test L2 hit backfills L1 and returns without querying L3.
  - Test true miss invokes L3 and backfills both L2 and L1.
  - Test SingleFlight coalesces duplicate miss requests.
  - Test negative caching prevents repeated L3 calls for non-existent keys.
  - Test `Clear(ctx, key)` purges from both tiers.
- [ ] Run `(cd go && CGO_ENABLED=0 go test -v ./core/coalesce/...)`.
- [ ] Commit task: `feat(go/core): implement pure-stdlib multi-tier coalesce loader and lru`.

---

### Task 2: Node / TypeScript `@batchLoad` Multi-Tier Integration
**Files:**
- Modify: `node/packages/core/src/decorators/batch-load.ts`
- Modify: `node/packages/core/src/decorators/batch-load.spec.ts`

**Interfaces:**
- Produces: `MGetCacheAdapter` interface in TypeScript:
  ```typescript
  export interface MGetCacheAdapter {
    mget(keys: string[]): Promise<Map<string, any> | Record<string, any>>;
    setMany(items: Map<string, any> | Record<string, any>, ttlSeconds?: number): Promise<void>;
    del?(keys: string[]): Promise<void>;
  }
  ```
- Extends: `BatchLoadOptions`:
  ```typescript
  export interface BatchLoadOptions<K, V> {
    // ... existing options ...
    cache?: {
      l1?: { maxEntries?: number; ttlMs?: number };
      l2?: { adapter: MGetCacheAdapter; ttlSeconds?: number };
      negativeTtlSeconds?: number;
    };
  }
  ```

**Deliverables & Steps:**
- [ ] Implement in-memory bounded LRU / TTL map in `batch-load.ts`.
- [ ] Update `BatchQueue.dispatch()`:
  - Query L1; immediately resolve hits.
  - For misses: if L2 adapter exists, call `l2.adapter.mget(missKeys)` in a single bulk call; backfill L1 with found items.
  - For remaining misses: execute batch `loaderFn(remainingKeys)`; backfill L2 via `setMany` and L1.
  - Store negative sentinel in L1/L2 for missing keys.
- [ ] Attach `.clear(key: K): Promise<void>` directly to the decorated method function for explicit cache eviction.
- [ ] Write Jest unit tests in `batch-load.spec.ts`:
  - Multi-tier cascading (L1 hit -> L2 hit -> L3 batch query).
  - L1 backfill verification.
  - Negative caching defense.
  - Invalidation test with `service.findUserById.clear(key)`.
- [ ] Run `(cd node && pnpm --filter @montionugera/server-decorator test:unit)`.
- [ ] Commit task: `feat(node/core): add multi-tier L1/L2 caching to @batchLoad`.

---

### Task 3: Python Async `@batch_load` Multi-Tier Integration
**Files:**
- Modify: `python/packages/core/src/server_decorator/decorators/coalesce.py`
- Modify: `python/packages/core/tests/unit/test_coalesce.py`

**Interfaces:**
- Extends: `@batch_load`:
  ```python
  def batch_load(
      batch_fn=None,
      *,
      batch_method=None,
      max_batch_size=100,
      window_seconds=0.001,
      deduplicate=True,
      key_of=None,
      context_var=None,
      l1_max_size: int = 0,
      l1_ttl_seconds: float = 0,
      l2_cache: Any = None,
      l2_ttl_seconds: float = 0,
      negative_ttl_seconds: float = 10,
      serializer: Callable[[Any], str] | None = None,
      deserializer: Callable[[str], Any] | None = None,
  )
  ```

**Deliverables & Steps:**
- [ ] Implement simple bounded LRU memory cache with TTL in `coalesce.py`.
- [ ] Update `BatchQueue` to check L1 -> L2 `mget` -> L3 `loader_fn` -> backfill L2 via `set_many` / pipelining and L1.
- [ ] Support negative caching for missing items.
- [ ] Attach `clear(key)` method to the decorated function.
- [ ] Write pytest unit tests in `test_coalesce.py`:
  - L1 hit skips L2 and L3.
  - L2 hit backfills L1.
  - L3 miss resolution and multi-tier backfill.
  - Negative caching.
  - Eviction via `svc.find_user_by_id.clear(key)`.
- [ ] Run `(cd python && uv run --package server-decorator --extra dev pytest packages/core/tests/unit)`.
- [ ] Commit task: `feat(python/core): add multi-tier L1/L2 caching to @batch_load`.

---

### Task 4: Documentation & Contributor Verification
**Files:**
- Modify: `website/src/content/docs/core/coalescing.mdx`
- Run: `bash scripts/contributor-check.sh`

**Deliverables & Steps:**
- [ ] Update `website/src/content/docs/core/coalescing.mdx` with:
  - Multi-tier caching architecture diagram.
  - Consistency models & staleness prevention guide (Request-Scoped vs Micro-TTL vs Invalidation).
  - Polyglot code examples for Go, TypeScript, and Python with `setMany` / pipelined caching.
- [ ] Install dependencies: `(cd website && pnpm install)`.
- [ ] Run `bash scripts/contributor-check.sh` and verify all 7 gates pass cleanly.
- [ ] Commit task: `docs(core): update coalescing guide with multi-tier caching and staleness prevention`.
- [ ] Ship feature via `psrw ship`.
- [ ] Promote release via `psrw promote`.

# Migration guide — v1.x → v2.0.0

`server-decorator` v2.0.0 is the first **polyglot** release: one repo, two packages (`server-decorator` on npm and PyPI), shared wire-format contracts in [`contracts/`](./contracts).

This guide covers every behavior change that affects existing Node consumers, plus the new Python package surface.

> **Operator action required (D-A):** see [§ Cache-key format](#cache-key-format-decision-6) below. You almost certainly want to flush the cache namespace before deploying v2.0.0.

## Summary of breaking changes (Node)

| # | Change | Decision | Impact |
|---|--------|----------|--------|
| 1 | `@nestjs/event-emitter` → `eventemitter3` | #8 | Type-level only |
| 2 | Cache-key format rewritten | #6 | All cached entries become misses |
| 3 | `CacheAdapter.get` returns `CACHE_MISS` for absent keys | D-B | User adapters must update |
| 4 | `kafkajs` declared as optional peer dep | #9 | Kafka users must add `npm install kafkajs` |
| 5 | `custom-logger.ts` removed (was undocumented, NestJS-coupled) | #8 | Affects no documented users |

## eventemitter3 swap (Decision #8)

The exported `globalEmitter` now has type `EventEmitter` from `eventemitter3` instead of `EventEmitter2` from `@nestjs/event-emitter`. The runtime API used by this package (`.emit(name, payload)`, `.on(name, handler)`, `.off(name, handler)`) is unchanged.

```diff
- import { EventEmitter2 } from '@nestjs/event-emitter'
+ import EventEmitter from 'eventemitter3'

- const myEmitter: EventEmitter2 = ...
+ const myEmitter: EventEmitter = ...

  globalEmitter.emit('UserService.created', payload)   // unchanged
```

If you never imported the type explicitly, no code change is required — just `pnpm install` v2.0.0.

`@nestjs/event-emitter`, `@nestjs/common`, `@nestjs/core`, and `rxjs` are all dropped from this package's dependencies. If your application still needs them, declare them yourself.

## Cache-key format (Decision #6)

**Before (v1.x):** `` `${ClassName}.${methodName}(${args.join(',')})` ``

**After (v2.0.0):** see [`contracts/rules/cache-key.md`](./contracts/rules/cache-key.md). Args are JSON-stringified with stable key ordering; over 250 UTF-8 bytes, the parens content is replaced with `sha256:<hex>`. The new algorithm matches the Python implementation byte-for-byte (modulo one irreducible JSON edge case for whole-number floats — see the rule doc).

### Rollout (D-A) — operator action required

Every existing entry in your Node consumer's cache becomes a miss on first access after upgrade. For consumers with high-cardinality hot caches (session lookups, expensive aggregations), the resulting thundering herd against the underlying datastore can cause incidents.

- **If your cache traffic is non-trivial:** flush the cache namespace before deploying v2.0.0.
  - Redis: `redis-cli -n <db> --pattern 'YourPrefix:*' --rdb /dev/null` then `DEL` the matched keys, OR `FLUSHDB` if the namespace is dedicated.
- **If your cache traffic is light:** accept a brief miss spike (~1 cache TTL window) and skip the flush.

No dual-read compat layer ships in v2.0.0 — the simplicity is intentional.

## CACHE_MISS sentinel (D-B)

`CacheAdapter.get(key)` now returns the new `CACHE_MISS` sentinel (a `Symbol.for('server-decorator.cache.miss')` in Node, a module-level singleton in Python) when the key is absent.

```typescript
// Before
class MyAdapter implements CacheAdapter {
  get(key: string) { return this.store.get(key) }   // returns undefined on miss
}

// After
import { CACHE_MISS } from 'server-decorator'

class MyAdapter implements CacheAdapter {
  get(key: string) {
    return this.store.has(key) ? this.store.get(key) : CACHE_MISS
  }
}
```

Built-in adapters in this package handle the sentinel internally. If you implement your own `CacheAdapter`, update it. The benefit: you can now cache `null`, `0`, `""`, and `false` as legitimate values — they're no longer interpreted as misses.

## Kafka peer dep (Decision #9)

`kafkajs` was effectively undeclared in v1.x (typed as `any`). v2.0.0 declares it as an optional peer dep:

```bash
# Before
npm install server-decorator    # Kafka silently broken if you didn't install kafkajs

# After
npm install server-decorator kafkajs    # Explicit
```

No code change beyond the install. Same for Python:

```bash
pip install server-decorator              # core, no Kafka
pip install server-decorator[kafka]       # + aiokafka
```

## Python (D-C — sync emit_on_success)

Sync methods decorated with `@emit_on_success(use_queue=True)` outside an event loop now run the side effect on a single-worker `ThreadPoolExecutor` instead of blocking the caller. To drain in-flight emits at process exit:

```python
import atexit
from server_decorator.decorators.emit_on_success import _EMIT_EXECUTOR

atexit.register(_EMIT_EXECUTOR.shutdown, wait=True)
```

If you only use async methods, or if you always run inside an event loop, this doesn't affect you.

## Python — `EmitOnSuccess` is `emit_on_success`

PEP 8 snake_case. The class form is `emit_on_success_class`.

```python
# Mirrors Node's @EmitOnSuccess
@emit_on_success(use_queue=True, queue="redis")
async def create_order(...): ...

# Class form (Decision #4)
@emit_on_success_class(use_queue=True, queue="redis")
class OrderService:
    async def create_order(...): ...    # auto-wrapped
    async def cancel_order(...): ...    # auto-wrapped
```

## Class-form decorators (Decision #4) — Python only

New in v2.0.0: `tracking_class()`, `cache_class(adapter, ttl)`, `emit_on_success_class(...)`. Each walks `vars(cls)` (NOT the MRO — N2) and applies the corresponding method-form decorator to every public method, with `include` / `exclude` / `include_private` opt-ins. See [`python/packages/core/README.md`](./python/packages/core/README.md).

## Phase 0 hygiene (D-D) — affects contributors only

The repo's pre-v2.0.0 working tree had iCloud-doubled files (`.git/refs/heads/main 2`, `.vscode/settings 2.json`, etc.) which were causing `git fsck` to fail. These are removed in v2.0.0 and the `* 2` pattern is gitignored. If you're contributing on a Mac with iCloud Documents on, double-check your local tree and add the same patterns to your global gitignore.

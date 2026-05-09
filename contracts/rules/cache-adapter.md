# `cache-adapter` (contract v1.0.0)

**Locked by D-B (2026-05-08).**

## Rule

`CacheAdapter.get(key)` returns either:

1. The cached value (any JSON-representable value, including `null`/`None`/`0`/`""`/`false`), OR
2. A distinct `CACHE_MISS` sentinel exported by the package, indicating the key is absent.

The decorator uses identity comparison (`cached is CACHE_MISS` in Python; `cached === CACHE_MISS` in Node) — *never* truthiness — to decide whether to call the wrapped function.

## Why

Pre-v2.0.0 Node code returned whatever `adapter.get` returned and treated `null`/`undefined` as "miss". This made caching `null` impossible (every call recomputed). The sentinel makes "key absent" and "key present with value `null`" distinguishable.

## Sentinel definition

- **Node:** `export const CACHE_MISS: unique symbol = Symbol.for('server-decorator.cache.miss')` (process-shared via `Symbol.for` so user adapters in separate modules can produce the same sentinel).
- **Python:** module-level singleton `CACHE_MISS = object()`. Re-exported from the package barrel.

Both are top-level exports. Built-in adapters (Redis-backed, in-memory, etc.) MUST translate "absent key" → `CACHE_MISS`. User-supplied adapters MUST do the same; existing adapters that return `null`/`undefined`/`None` need updating.

## CACHE_MISS in `set`

`set` does not interact with the sentinel — adapters serialize whatever value they get. Caching `CACHE_MISS` itself is undefined behavior (it shouldn't ever happen because the user code never sees it).

## Examples

```python
# python
from server_decorator import cache, CACHE_MISS

class InMemoryAdapter:
    def __init__(self): self._d: dict[str, Any] = {}
    def get(self, key):
        return self._d.get(key, CACHE_MISS)   # absent → sentinel
    def set(self, key, value, ttl):
        self._d[key] = value                  # cached None is preserved
```

```typescript
// node
import { CACHE_MISS, type CacheAdapter } from 'server-decorator';

class InMemoryAdapter implements CacheAdapter {
  private d = new Map<string, unknown>();
  get(key: string) { return this.d.has(key) ? this.d.get(key) : CACHE_MISS; }
  set(key: string, value: unknown, _ttl: number) { this.d.set(key, value); }
}
```

# ADR 0004 — `CACHE_MISS` sentinel for adapter contract

**Status:** Accepted (2026-05-08). Locked as D-B.

## Context

Pre-v2.0.0 Node `@cache` returned whatever `adapter.get(key)` returned. Misses were detected as "value is `undefined`/`null`". This made caching a `null`/`None` value impossible — every call recomputed.

## Options

1. **Sentinel.** `adapter.get` returns a distinct `CACHE_MISS` object on miss; the decorator uses `cached !== CACHE_MISS` (identity, not truthiness) to detect a hit.
2. **Tuple return.** `adapter.get` returns `(found: bool, value)`. Forces callers and adapters to destructure.
3. **Throw on miss.** `adapter.get` raises a `KeyMiss` exception. Forces every cache check through a `try/except`.

## Decision

Option 1.

## Why

- **Cleanest call site.** `if cached is not CACHE_MISS: return cached` reads naturally. Tuple destructuring or try/except adds noise.
- **No allocation per miss.** Sentinel comparison is identity. Tuples allocate on every call; exceptions are expensive when miss is common.
- **Symmetric across languages.** Python uses a module-level `object()` sentinel; Node uses `Symbol.for('server-decorator.cache.miss')` so adapters in separate modules produce the *same* symbol (process-shared via the Symbol registry).
- **No conflict with valid cached values.** A user can cache `None`, `null`, `0`, `""`, `False` — the decorator only returns the underlying function's result if `adapter.get` literally returned `CACHE_MISS`.

## Consequences

- User-implemented `CacheAdapter` classes must return `CACHE_MISS` (imported from the package) when the key is absent. Documented in MIGRATION.md.
- Built-in adapters in this package handle the sentinel internally; users who only use built-in adapters need no code change.
- The sentinel is exported as a top-level symbol of the package — `import { CACHE_MISS } from 'server-decorator'` (Node) and `from server_decorator import CACHE_MISS` (Python).

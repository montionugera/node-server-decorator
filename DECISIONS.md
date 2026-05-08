# DECISIONS

Source of truth for binding decisions on the Node + Python polyglot migration. Revisit any item only via a written ADR under `docs/adr/`.

The full migration plan lives at `~/workspace/wip/decoratorpolyglotmigrationplan.md` (canonical) — this file is its in-repo summary so contributors don't need access to that path.

## Original 12 (locked 2026-05-05)

1. **Python package name.** Publish as `server-decorator` on PyPI (import name `server_decorator`).
2. **Versioning.** Lockstep semver: one tag (`v1.2.3`), both packages publish together.
3. **TypeScript decorator syntax.** Keep stage-2 / `experimentalDecorators` style. TC39 migration is a separate follow-up.
4. **Python decorator surface.** Both method-level and class-level decorators (class form auto-wraps every public method). Skip `_private`, `__dunder__`, and `@property` by default; opt back in via `include`/`include_private`/`wrap_properties`. Inheritance: walk only `vars(cls)`, never the MRO. Class forms get distinct names (`tracking_class`, `cache_class`, `emit_on_success_class`).
5. **`@tracking` in Python.** Detect coroutines via `inspect.iscoroutinefunction`; support sync and async. Node stays async-only.
6. **Cache key format.** `<ClassName>.<methodName>(<json-args>)` with stable key ordering. If >250 bytes UTF-8, replace parens content with `sha256:<hex>`. Spec: `contracts/rules/cache-key.md`.
7. **Event payloads.** Anything published to a queue must be JSON-serializable. In-process emitter calls may pass rich objects.
8. **Event emitter dependency.** Drop `@nestjs/event-emitter`; replace with `eventemitter3`. Ships in v2.0.0 as the one intentional Node breaking change.
9. **Kafka client.** Optional peer dep: `kafkajs` (Node), `aiokafka` (Python via `pip install server-decorator[kafka]`).
10. **Python async runtime.** `asyncio` only. No `trio`/`anyio`.
11. **Repo tooling.** Two folders side by side (`node/`, `python/`). No monorepo tool.
12. **Node backward compatibility.** `npm install server-decorator` continues to work unchanged (apart from the v2.0.0 eventemitter3 swap).

## Additional decisions (locked 2026-05-08, after plan review)

- **D-A.** Cache-key change rollout: documented as a one-time miss in `MIGRATION.md`. No dual-read or feature flag. Operators with hot caches must flush before deploying v2.0.0.
- **D-B.** Cache-hit detection: introduce a top-level `CACHE_MISS` sentinel exported by both packages. `CacheAdapter.get` returns `CACHE_MISS` on absent key — lets users cache `None`/`null`/`0`/`""`/`False` as legitimate values. Spec: `contracts/rules/cache-adapter.md`.
- **D-C.** Python `@emit_on_success` sync fallback: a module-level single-worker `ThreadPoolExecutor` (`_EMIT_EXECUTOR`) runs `asyncio.run(_on_success(...))` so the sync caller doesn't block when no event loop is running.
- **D-D.** Phase 0 hard-blocks on git hygiene: `git fsck --full` must be clean and iCloud-doubled `* 2` files removed before Phase 1.

## Newly-surfaced open questions from Decision #4 (locked, default-accepted)

- **N1.** `@property` wrapping deferred to v1.1+ behind `wrap_properties=False` default.
- **N2.** Class decorator walks only `vars(cls)`, never the MRO. Documented loudly.
- **N3.** When `@tracking_class()` and `@cache_class()` stack, last-applied is outermost (matches Python decorator semantics). One explicit test asserts ordering.
- **N4.** Class forms exported under distinct names (`tracking_class`, `cache_class`, `emit_on_success_class`) — no overload-on-target trickery.

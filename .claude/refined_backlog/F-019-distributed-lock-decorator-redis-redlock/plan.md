# Redis Distributed Lock Decorator Implementation Plan (F-019)

> **Goal**: Implement polyglot Redis distributed mutual exclusion decorator (`@distributedLock` / `@distributed_lock` & `@distributed_lock_class` / Go `distlock.Locker`) with safe token verification, auto-renewal watchdog, and contention queueing without third-party dependencies in Go.
> **Architecture Spec**: [`docs/superpowers/specs/2026-09-21-distributed-locking-design.md`](file:///Users/pasitnusso/workspace/repos/node-server-decorator/.claude/worktrees/_release/docs/superpowers/specs/2026-09-21-distributed-locking-design.md)

---

## Proposed Changes

### Phase 1: Shared Adapter Interface & Atomic Lua Scripts
- Define standard `RedisLockAdapter` contract with `setNxPx` and `evalLua`.
- Define standardized atomic Lua scripts for release and renewal.
- Quality Gate: Unit tests validating Lua script logic against in-memory mock Redis adapter.

### Phase 2: Node/TypeScript Implementation (`node/packages/core`)
- Implement `RedisLockAdapter` interface and `distributedLock` decorator in `node/packages/core/src/decorators/distributed-lock.ts`.
- Implement unref'd heartbeat watchdog timer (`setInterval(...).unref()`) extending TTL every `ttlMs / 3`.
- Implement `waitTimeoutMs` contention loop with randomized jittered backoff.
- Implement `configureDistributedLock` for default adapter configuration.
- Export in `node/packages/core/src/index.ts`.
- Quality Gate: Unit tests (`distributed-lock.spec.ts`) testing mutual exclusion, watchdog renewal, fail-fast on contention, and safe token release.

### Phase 3: Python Asyncio Implementation (`python/packages/core`)
- Implement `@distributed_lock` decorator and `@distributed_lock_class` in `python/packages/core/src/server_decorator/decorators/distributed_lock.py` using `_class_apply`.
- Implement asyncio renewal task with fail-closed cancellation on renewal loss.
- Export in `python/packages/core/src/server_decorator/__init__.py`.
- Quality Gate: Pytest unit tests in `python/packages/core/tests/unit/test_distributed_lock.py`.

### Phase 4: Go Implementation (`go/core/distlock`)
- Implement zero-dependency `distlock.RedisClient` interface, `Config`, and `Locker` in `go/core/distlock/locker.go`.
- Implement background goroutine for heartbeat renewal with context cancellation.
- Quality Gate: Unit tests in `go/core/distlock/locker_test.go` verifying mutual exclusion and watchdog extension.

### Phase 5: Verification & Promotion
- Run `bash scripts/contributor-check.sh` (all 7 quality gates).
- Ship via `psrw ship`.

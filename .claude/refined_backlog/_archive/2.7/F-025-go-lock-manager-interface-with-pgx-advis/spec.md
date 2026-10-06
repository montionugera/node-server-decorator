---
title: "Go lock manager interface with pgx advisory-lock adapter in a nested module"
id: F-025
status: refined
from_idea: I-028
---

# Go lock manager interface with pgx advisory-lock adapter in a nested module

Slice of epic E-001 (verified adoptions). Go only. Target branch: `release/2.7`.

## 1. Problem

The service `joy-data-platform` hand-writes a try-or-skip lock for its background job
scheduler. Two replicas must not run the same job at once.

| File | Lines | What it is |
|---|---|---|
| `internal/worker/advisory_lock.go` | 138 | `LockManager` interface, in-memory, no-op and Postgres implementations, plus `tryLock` / `unlock` helpers |
| `internal/worker/advisory_lock_test.go` | 55 | Three tests: in-memory, no-op, nil pool. **No test touches Postgres** |

Wiring that uses it, in `internal/worker/scheduler.go`:

- Lines 45-60: `WithLockManager(LockManager)` and `WithPgxPool(pool)`. The second builds
  `NewPostgresLockManager(pool)` when no manager was set.
- Lines 256-271: `release, acquired, err := s.lockMgr.AcquireLock(ctx, jobID)`. An error
  fails the run. `acquired == false` returns `ErrJobRunning`. Otherwise `defer release()`.
- Lines 232-243: two methods `Scheduler.tryLock` and `Scheduler.unlock` that call the
  package helpers. Nothing calls them. They are dead code.

The library has `go/core/distlock` (a Redis lease lock with renewal). It has no
try-or-skip manager interface and no Postgres backend.

## 2. Public API

### 2a. Interface, in the zero-dependency root module

Package `distlock`, import path
`github.com/montionugera/node-server-decorator/v2/go/core/distlock`.
New file `go/core/distlock/manager.go`. Standard library only.

```go
// Manager is a try-or-skip lock coordinator. It never waits for a held lock.
type Manager interface {
	// AcquireLock tries to take the lock for key.
	// acquired is false, with a nil error, when another holder has it.
	// release is never nil. It frees the lock, is idempotent and is safe to defer.
	AcquireLock(ctx context.Context, key string) (release func(), acquired bool, err error)
}

// MemoryManager is a process-local Manager for single-replica runs and tests.
type MemoryManager struct{ /* unexported */ }
func NewMemoryManager() *MemoryManager
func (m *MemoryManager) AcquireLock(ctx context.Context, key string) (func(), bool, error)

// NoopManager always grants the lock. Use it to switch locking off.
type NoopManager struct{}
func NewNoopManager() *NoopManager
func (NoopManager) AcquireLock(ctx context.Context, key string) (func(), bool, error)
```

The names do not clash with the existing `distlock` exports (`Locker`, `Lock`, `Config`,
`Option`, `New`, `RedisClient`).

### 2b. Postgres adapter, in a nested module

- Directory: `go/adapter/pgxlock/`
- Module path: `github.com/montionugera/node-server-decorator/v2/go/adapter/pgxlock`
- Package name: `pgxlock`
- Files: `go.mod`, `go.sum`, `doc.go`, `pgxlock.go`, `pgxlock_test.go`,
  `pgxlock_integration_test.go`

```go
// Manager takes a session-scoped Postgres advisory lock on a leased pool connection.
type Manager struct{ /* unexported */ }

type Option func(*Manager)

// New builds a Manager on pool. A nil pool is allowed: AcquireLock then returns an error.
func New(pool *pgxpool.Pool, opts ...Option) *Manager

// WithKeyPrefix sets the text put before the key before hashing. Default "job:".
func WithKeyPrefix(prefix string) Option
// WithAcquireTimeout bounds leasing the connection plus the lock query. Default 5s.
func WithAcquireTimeout(d time.Duration) Option
// WithUnlockTimeout bounds the unlock query. Default 5s.
func WithUnlockTimeout(d time.Duration) Option

func (m *Manager) AcquireLock(ctx context.Context, key string) (release func(), acquired bool, err error)

// ErrNilPool is returned by AcquireLock when New was given a nil pool.
var ErrNilPool = errors.New("pgxlock: pool is nil")
```

`*pgxlock.Manager` satisfies `distlock.Manager` by method set. It does **not** import the
root module. See the design notes for why.

Internally `pgxlock.go` talks to the pool through two small **unexported** interfaces
(a connection with `QueryRow`, `Exec`, `Release` and a close method, and a function that
leases one). `New` wires them to the real `*pgxpool.Pool`. Because the integration test
runs locally rather than in CI, the concrete `*pgxpool.Pool` wrapper methods are kept
strictly to one-line delegations:
- `poolAdapter.Acquire(ctx)` delegating to `pool.Acquire(ctx)`
- `connAdapter.QueryRow(ctx, sql, args...)` delegating to `conn.QueryRow(ctx, sql, args...)`
- `connAdapter.Exec(ctx, sql, args...)` delegating to `conn.Exec(ctx, sql, args...)`
- `connAdapter.Release()` delegating to `conn.Release()`
- `connAdapter.Close(ctx)` delegating to `conn.Conn().Close(ctx)`

These delegation lines are covered only by the local integration run; the unit test
coverage target excludes exactly these lines. The unit tests supply fakes for all logic.

### 2c. How the root module, go.work and CI treat the nested module

- `go/adapter/pgxlock/go.mod` declares `go 1.22` and requires
  `github.com/jackc/pgx/v5 v5.7.4`. That is the newest pgx release whose own `go.mod`
  says `go 1.21`; v5.7.5 needs Go 1.23 and v5.8.0 needs Go 1.24. CI installs the Go
  version from the root `go.mod` (1.22).
- The nested `go.mod` has **no** `require` and **no** `replace` for the root module.
- The root `go.mod` is not edited. No root `go.sum` is created.
- **Do not add a `go.work` file.** None exists today. With a workspace, the pattern
  `./go/...` at the root would start to include the nested module and pull pgx into the
  dependency-free test and coverage run.
- A directory with its own `go.mod` is a module boundary. `go test ./go/...`,
  `go vet ./go/...` and `scripts/check-go-coverage.sh` at the root skip
  `go/adapter/pgxlock` automatically, exactly as they skip `go/adapter/gin` today.
- `.github/workflows/ci-go.yml`: add one step after the gin step:
  `cd go/adapter/pgxlock && go vet ./... && go test ./...`.
- The real-Postgres integration test stays behind `//go:build integration` and is run
  LOCALLY; its command and output are recorded as evidence (no new CI job with a Postgres
  service container in this slice).
- `scripts/contributor-check.sh`: add the same block it has for gin:
  `(cd "$ROOT_DIR/go/adapter/pgxlock" && CGO_ENABLED=0 go test ./...)`.
- `scripts/check-go-coverage.sh`: add `go/adapter/pgxlock` to the header comment that
  explains why `go/adapter/gin` has no threshold. No table entry.

## 3. Behaviour contract

"Differs" marks where the service does something an obvious implementation would not, or
where this spec deliberately departs from the service.

**All managers**

1. `AcquireLock` never waits for a held lock. It returns at once with `acquired == false`
   and `err == nil`.
2. **Differs from the service.** `release` is never nil. When `acquired` is false or
   `err` is non-nil it is a no-op. The service returns a nil `release` in those cases;
   its only caller checks `acquired` first, so a non-nil no-op loses nothing.
3. `release` is idempotent. A second call does nothing. It is safe from any goroutine.
4. Cancelling `ctx` after a successful acquire does not free the lock. Only `release`
   does.

**MemoryManager**

5. The first `AcquireLock(key)` returns `acquired == true`. A second call for the same
   key, before release, returns `acquired == false`, `err == nil`.
6. After `release()`, the next `AcquireLock` for that key returns `acquired == true`.
7. Different keys are independent.
8. It ignores `ctx` and never returns an error.
9. A stale `release` called twice must not free a later holder of the same key. Sequence:
   A acquires, A releases, B acquires, A calls release again. B still holds the lock.
10. It is safe under concurrent use. With 100 goroutines racing for one key, exactly one
    gets `acquired == true`. `go test -race` passes.

**NoopManager**

11. Every call returns a non-nil no-op `release`, `acquired == true`, `err == nil`, for
    any key and any number of concurrent callers.

**pgxlock.Manager: acquire**

12. With a nil pool, `AcquireLock` returns `acquired == false` and `ErrNilPool`. It does
    not panic.
13. **Differs.** It leases one dedicated connection from the pool per held lock and keeps
    it out of the pool until `release`. The lock is session-scoped, so it must stay on
    that one connection. Each held lock costs one pool connection.
14. **Differs.** One timeout (`WithAcquireTimeout`, default 5 s) covers both leasing the
    connection and running the lock query. It is derived from the caller's `ctx`, so an
    earlier caller deadline or cancel still wins.
15. A failure to lease a connection returns `acquired == false` and an error that wraps
    the pool error with `%w`. `errors.Is(err, context.DeadlineExceeded)` is true when the
    pool was exhausted for the whole timeout.
16. The lock query is exactly `SELECT pg_try_advisory_lock(hashtext($1))`. The single
    parameter is `prefix + key`, joined in Go.
17. **Key compatibility.** With the default prefix, the lock taken for key `k` is the
    same lock as the service's `pg_try_advisory_lock(hashtext('job:' || 'k'))`. An old
    replica and a new replica must exclude each other during a rolling deploy.
18. `hashtext` returns a 32-bit integer. Two different keys can hash to the same value
    and then exclude each other. This is inherited and accepted.
19. If the query returns false, the connection goes back to the pool at once and the
    result is `acquired == false`, `err == nil`.
20. **Differs.** On ANY error from the lock query, the connection is closed bounded by
    a timeout (it is not returned to the pool), and `AcquireLock` returns `acquired == false`
    with that error. Reason: if Postgres granted the lock but the reply was lost, an idle
    pooled session would hold it.
21. A second `AcquireLock` for the same key from the same `Manager` returns
    `acquired == false` while the first is held. It runs on a different connection, so
    Postgres does not treat it as a re-entrant acquire.

**pgxlock.Manager: release**

22. `release` runs `SELECT pg_advisory_unlock(hashtext($1))` with the same parameter, on
    the same leased connection.
23. **Differs.** The unlock runs on `context.Background()` plus `WithUnlockTimeout`
    (default 5 s). It does not use the caller's `ctx`, which is often already cancelled
    when a deferred `release` runs.
24. The connection is returned to the pool exactly once per successful acquire, whether
    the unlock query succeeds or fails, and however many times `release` is called.
25. **Differs from the service.** If the unlock query returns an error, `release` closes
    the underlying connection before returning it to the pool. The service returns the
    connection as is. If the unlock did not happen, that connection would keep the
    session lock while sitting idle in the pool, and the job would be locked out until
    the connection is recycled. Closing ends the session, so Postgres frees the lock.
26. `release` returns nothing and swallows the unlock error, as the service does.
27. After `release`, another connection can take the same lock.

## 4. Non-goals

- No blocking acquire, no wait timeout, no retry. Use `distlock.Locker` for that.
- No lease, no time-to-live, no renewal, no lost-lock signal. A session advisory lock
  lives until unlock or until the connection ends.
- No transaction-scoped locks (`pg_try_advisory_xact_lock`).
- No custom hash function or 64-bit key option. Only the prefix is configurable.
- No adapter that turns `distlock.Locker` (Redis) into a `Manager`.
- No Node, Python or Nim lock manager and no Postgres backend there. No site needs them.
- No `database/sql` or pgx v4 support.
- No metrics, no logging.
- No release tag for the nested module and no version bump. See the design notes.

## 5. Compatibility

- Additive only. New file in `go/core/distlock`. New nested module. No existing export
  changes.
- No `contracts/` change.
- The root module stays dependency-free: root `go.mod` unchanged, no root `go.sum`.
- Coverage gate for the root part: `scripts/check-go-coverage.sh` lists
  `go/core/distlock` at **100** percent statement coverage. `manager.go` must be fully
  covered. Do not lower the number.
- Coverage gate for the nested module: none, by the existing rule for separate modules
  (see the `go/adapter/gin` note at the top of `scripts/check-go-coverage.sh`). Its
  tests still run in `ci-go.yml` and `scripts/contributor-check.sh`. This spec asks for
  at least 90 percent statement coverage from the unit tests alone, checked by hand with
  `cd go/adapter/pgxlock && go test -cover ./...`. Because the integration test runs locally
  rather than in CI, the concrete `*pgxpool.Pool` wrapper methods are kept strictly to
  one-line delegations (`poolAdapter.Acquire`, `connAdapter.QueryRow`, `connAdapter.Exec`,
  `connAdapter.Release`, `connAdapter.Close`); only those lines are covered exclusively by
  the local integration run, and the unit coverage target excludes exactly those lines.

## 6. Test code stays out of production

- `go/core/distlock/manager_test.go`, `package distlock`: tests for statements 1 to 11.
- `go/adapter/pgxlock/pgxlock_test.go`, `package pgxlock`: unit tests with fake
  connections. The fakes are declared in this `_test.go` file only.
- `go/adapter/pgxlock/pgxlock_integration_test.go`: first line `//go:build integration`.
  It needs a real Postgres. It reads `PGXLOCK_TEST_DATABASE_URL` and fails with a clear
  message when the variable is empty. It is never compiled without the tag.
- The seam interfaces in `pgxlock.go` are unexported. No exported fake, mock, test hook
  or `NewForTest` constructor exists. Go never compiles `_test.go` files into an
  importing program.
- `MemoryManager` is a production type (single-replica mode). It is not a test fake,
  although tests may use it.

## 7. Documentation to update

- `go/README.md`, package table: add a row for `pgxlock` at `go/adapter/pgxlock`, marked
  as a separate module like the `gin` row.
- `go/README.md`, section `### Distributed lock (go/core/distlock)`: add a subsection
  `#### Try-or-skip lock manager` showing `distlock.Manager`, `NewMemoryManager`,
  `NewNoopManager`, and `pgxlock.New(pool)`. It must state statements 13, 17, 18 and 25,
  and say that the pool needs one spare connection per concurrently held lock.
- `go/README.md`, section `## Testing & Coverage Gate`: add the two `pgxlock` commands
  (unit, and integration with the build tag and environment variable).
- New `go/adapter/pgxlock/doc.go` package comment with the same four statements.
- Repo `CLAUDE.md`: the sentence "`go/adapter/gin` is a separate module ... (the only
  place a third-party dependency is allowed)" must name `go/adapter/pgxlock` as the
  second such place. Add the two commands to the commands table.

## 8. Acceptance criteria

- [ ] `go test ./go/...` passes from the repo root.
- [ ] `bash scripts/check-go-coverage.sh` passes with `go/core/distlock` still at threshold 100 and no entry for `go/adapter/pgxlock`.
- [ ] `bash scripts/check-versions.sh` passes (no version changed).
- [ ] `test -z "$(gofmt -l go)" && go vet ./go/...` passes.
- [ ] `git diff --stat release/2.7 -- go.mod contracts/` prints nothing, and `test ! -e go.sum && test ! -e go.work` succeeds at the repo root.
- [ ] `! go list -deps ./go/... | grep -q jackc` at the repo root (the root module does not see pgx).
- [ ] `! grep -q 'node-server-decorator/v2 ' go/adapter/pgxlock/go.mod` and `! grep -q '^replace' go/adapter/pgxlock/go.mod` (no require or replace of the root module).
- [ ] All managers and MemoryManager: `go test -race ./go/core/distlock -run 'TestMemoryManager|TestManagerContract'` passes and covers statements 1 to 10, including the stale-release case (9) and the 100-goroutine race (10).
- [ ] NoopManager: `go test ./go/core/distlock -run TestNoopManager` passes and covers statement 11.
- [ ] pgxlock unit: `cd go/adapter/pgxlock && go vet ./... && go test -race -cover ./...` passes without Postgres, reports at least 90 percent, and covers statements 12, 14, 15, 16, 19, 20, 22, 23, 24, 25 and 26 with fakes. One test asserts the fake connection's `Release` count is exactly 1 after two `release()` calls. One test asserts the connection is closed when the unlock query fails. One test asserts the fake connection is closed (bounded by a timeout) when the lock query fails on ANY error (statement 20).
- [ ] pgxlock local integration: with a local Postgres, `cd go/adapter/pgxlock && PGXLOCK_TEST_DATABASE_URL=postgres://... go test -tags integration ./...` is run locally, passes and covers statements 13, 17, 21 and 27, and its command and output are recorded as evidence.
- [ ] Key compatibility (statement 17): the integration test holds key `k` through the library, then on a separate raw connection runs the service's literal SQL `SELECT pg_try_advisory_lock(hashtext('job:' || 'k'))` and gets `false`; after `release()` the same SQL returns `true`.
- [ ] Pool accounting (statements 13, 24): the integration test reads `pool.Stat().AcquiredConns()`. It is 1 while the lock is held and 0 after `release()`, and 0 after a not-acquired attempt.
- [ ] Nested module hygiene: `cd go/adapter/pgxlock && GOTOOLCHAIN=local go mod tidy && go build ./... && git diff --exit-code go.mod go.sum` passes.
- [ ] pgx v5.11.0 compatibility: one local integration run against pgx v5.11.0 (the version `joy-data-platform` uses) is executed, with its command and output recorded as evidence.
- [ ] A compile-time check in `go/adapter/pgxlock/pgxlock_test.go` assigns `*Manager` to a locally declared interface with the exact `AcquireLock` signature from section 2a.
- [ ] `cd go/adapter/pgxlock && go doc .` lists only `Manager`, `New`, `Option`, `WithKeyPrefix`, `WithAcquireTimeout`, `WithUnlockTimeout`, `ErrNilPool`.
- [ ] `grep -n 'pgxlock' .github/workflows/ci-go.yml scripts/contributor-check.sh` shows the new unit step and the contributor-check block (no integration job in CI).
- [ ] `grep -n 'Try-or-skip lock manager' go/README.md` finds the new subsection.

## 9. Adoption check

Once this ships, these `joy-data-platform` files should be deletable:

- `internal/worker/advisory_lock.go` (138 lines)
- `internal/worker/advisory_lock_test.go` (55 lines)

What must change in `internal/worker/scheduler.go` for that to compile:

- Line 46 and line 70: the type `LockManager` becomes `distlock.Manager`.
- Line 57: `NewPostgresLockManager(pool)` becomes `pgxlock.New(pool)`. The default prefix
  `job:` keeps the lock identity.
- Lines 232-243: delete the dead methods `Scheduler.tryLock` and `Scheduler.unlock`. They
  call the deleted helpers. Nothing calls them.
- Lines 256-271: unchanged. `release, acquired, err := s.lockMgr.AcquireLock(...)` has
  the same shape.
- `internal/worker/scheduler_test.go:276`: `worker.NewMemoryLockManager()` becomes
  `distlock.NewMemoryManager()`.

The service test `TestTryLock_NilPool` is replaced by library statement 12. The exported
helpers `worker.TryLock` and `worker.Unlock` have no caller outside the deleted test.

## Design notes

- **The nested module does not import the root module.** `go/adapter/gin` does, with a
  `replace` to `../../../` and a placeholder version. Go ignores `replace` lines in a
  dependency, so a consumer cannot `go get` that module at a tag. `pgxlock` needs nothing
  from the root module: Go interfaces are satisfied by method set. So it has no `require`
  on the root and stays installable on its own. The cost is that the interface match is
  checked against a local copy of the signature in a test, and by the adoption build.
- **Release is never nil** (statement 2). Changed from the service to make
  `defer release()` always safe.
- **Close on failed acquire or unlock** (statements 20 and 25). Added. On ANY error
  from the lock query, or on unlock query failure, the connection is closed bounded by a
  timeout before release. If Postgres granted the lock but the reply was lost or unlock
  failed, an idle pooled connection would keep the session lock indefinitely; closing
  ends the backend session so Postgres frees the lock.
- **Prefix joined in Go** (statement 16). `hashtext('job:' || 'k')` and
  `hashtext('job:k')` are the same value. Sending one parameter avoids relying on
  Postgres to infer the type of two untyped parameters. Statement 17 proves the match
  against the service's literal SQL.
- **Follow-up: Release pipeline: tag nested Go modules (`go/adapter/pgxlock/vX.Y.Z`).**
  A consumer on a real release needs a git tag named `go/adapter/pgxlock/vX.Y.Z`. The release
  pipeline (`ci-node.yml`) pushes only `vX.Y.Z` today, and no `go/adapter/gin/v*` tag
  exists. Adoption uses a local replace line until then.
- **Integration test local-only (owner decision).** NO new CI job with a Postgres service
  container is added in this slice. The real-Postgres integration test stays behind the
  `integration` build tag and is run locally, with command and output recorded as
  evidence.

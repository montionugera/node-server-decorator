# Go lock manager interface with pgx advisory-lock adapter in a nested module — Implementation Plan

**Goal (verbatim from the spec title):** Go lock manager interface with pgx advisory-lock
adapter in a nested module. Source of truth: `spec.md` in this folder. Statement numbers
below ("S5") refer to spec section 3.

**Architecture:** two independent parts.

1. `go/core/distlock/manager.go` in the root module (standard library only): the
   `Manager` interface, `MemoryManager`, `NoopManager`.
2. `go/adapter/pgxlock/` as a nested module with its own `go.mod` (`go 1.22`,
   `github.com/jackc/pgx/v5 v5.7.4`, no `require`/`replace` of the root module). It
   satisfies `distlock.Manager` by method set and never imports the root module.

**Global constraints**

- Root `go.mod` unchanged; no root `go.sum`; no `go.work`.
- No edits to Node, Python, Nim, `contracts/`, `_catalog.json`, or unrelated Go code.
- **Deviation from the spec, imposed by the orchestrator of this run:** nothing under
  `.github/workflows/` is edited. Spec section 2c and one acceptance line ask for a unit
  step in `ci-go.yml`; that single step is NOT done in this slice and is reported as an
  open follow-up. `scripts/contributor-check.sh` does get its block.
- Every Go command on this Mac: `export GOFLAGS=-ldflags=-linkmode=external` first.
- New commits only, one per task, never `--amend`. No ship, push or pull request.
- Each task ends with the quality gate: verify, independent review, refactor, re-verify.
  Tasks 1 to 3 are small diffs in one subsystem, so they share ONE independent Go review
  (Task 4); its fixes land as their own commit.

## Design decisions fixed here (spec ambiguities)

- **Seam.** Two unexported interfaces in `pgxlock.go`:
  `lockConn { QueryRow; Exec; Release(); Close(ctx) error }` and
  `leaser { Acquire(ctx) (lockConn, error) }`. `New` stores `poolAdapter{pool}` only when
  `pool != nil`, so the nil check in `AcquireLock` is on the interface field (a nil
  `*pgxpool.Pool` inside an interface would not compare equal to nil).
- **"Closed, not returned to the pool" (S20, S25).** A leased `*pgxpool.Conn` must still
  have `Release()` called or the pool slot leaks forever. So the sequence is
  `Close(ctx)` then `Release()`: pgxpool destroys a closed connection on release instead
  of reusing it. `Release` is therefore called exactly once on every path that leased a
  connection (S24).
- **Close timeout.** `Close` runs on `context.Background()` plus the unlock timeout, in
  both S20 and S25, because the acquire context may already be expired.
- **Error wrapping.** Lease errors (S15) and lock-query errors (S20) are both wrapped
  with `%w` and a `pgxlock:` prefix; `errors.Is` still matches the cause.
- **Unlock result.** `pg_advisory_unlock` returning `false` is not an error and is
  ignored, as in the service (`Exec`, result discarded).

## Tasks

### Task 1 — `distlock.Manager`, `MemoryManager`, `NoopManager` (root module)

Files: create `go/core/distlock/manager_test.go`, `go/core/distlock/manager.go`.

- [x] 1.1 Write `manager_test.go` (`package distlock`) first:
  - `TestManagerContract`: table over `NewMemoryManager()` and `NewNoopManager()` held as
    `Manager`; release never nil, release twice is safe, acquire with an already
    cancelled ctx still succeeds and cancelling after acquire does not free a memory
    lock (S1 to S4, S8).
  - `TestMemoryManager*`: first acquire true, second false with nil error and a non-nil
    no-op release (S5, S2); `release` called from several goroutines at once (S3);
    reacquire after release (S6); independent keys (S7); stale
    double release does not free a later holder (S9); 100 goroutines, exactly one
    winner (S10).
  - `TestNoopManager`: always true, non-nil release, concurrent callers (S11).
- [x] 1.2 Run `go test ./go/core/distlock -run 'Manager'` and see it FAIL to compile (red).
- [x] 1.3 Write `manager.go` (stdlib only) to make it pass.
- [x] 1.4 Verify: `go test -race ./go/core/distlock -run 'TestMemoryManager|TestManagerContract|TestNoopManager'`,
  `gofmt -l go` empty, `go vet ./go/...`, `bash scripts/check-go-coverage.sh`
  (`go/core/distlock` must stay at 100).
- [x] 1.5 Commit: `feat(go): add distlock.Manager with memory and no-op managers`.

### Task 2 — `pgxlock` nested module with fake-driven unit tests

Files: create `go/adapter/pgxlock/{go.mod,go.sum,doc.go,pgxlock.go,pgxlock_test.go}`.

- [x] 2.1 Create `go.mod` (module path from spec 2b, `go 1.22`, pgx `v5.7.4`).
- [x] 2.2 Write `pgxlock_test.go` (`package pgxlock`, fakes declared here only) first:
  - compile-time check: `*Manager` assigned to a locally declared interface with the
    exact `AcquireLock` signature of spec 2a.
  - nil pool returns `ErrNilPool`, `acquired == false`, non-nil release, no panic (S12).
  - in every not-acquired or error case (S12, S15, S19, S20) `release` is non-nil and
    calling it changes no `Exec`/`Close`/`Release` count (S2).
  - `release` from several goroutines at once keeps `Exec` and `Release` at 1 (S3).
  - `New(&pgxpool.Pool{})` wires the real adapter (the non-nil branch of `New`, without
    Postgres; the pool is never called).
  - defaults and options (`job:` prefix, 5 s timeouts; each `With*` applies).
  - lease and lock query share one deadline bounded by the acquire timeout; an already
    cancelled caller ctx reaches the lease cancelled (S14).
  - lease failure is wrapped with `%w`; an exhausted fake pool gives
    `errors.Is(err, context.DeadlineExceeded)` (S15); `Release` count 0 (nothing leased).
  - exact lock SQL and the single argument `prefix + key`, default and custom prefix (S16).
  - not acquired: `Release` count 1, `Close` count 0, nil error (S19).
  - lock query error: `Close` count 1 with a live, deadline-bounded ctx, `Release`
    count 1, error wraps the cause (S20).
  - release: exact unlock SQL, same argument, same connection (S22); runs on a live ctx
    with a deadline even though the caller ctx is cancelled (S23); two `release()` calls
    give `Exec` count 1 and `Release` count exactly 1 (S24); unlock error closes the
    connection once, before the single `Release` (S25), and `release` returns normally
    (S26).
- [x] 2.3 Run `go test ./...` in the module and see it FAIL (red): either a compile
  error or "missing go.sum entry". Do NOT run `go mod tidy` before `pgxlock.go` exists.
- [x] 2.4 Write `doc.go` (package comment stating S13, S17, S18, S25 and the "one spare
  pool connection per held lock" rule) and `pgxlock.go`. The concrete adapter methods are
  delegations only.
- [x] 2.5 `GOTOOLCHAIN=local go mod tidy`, then verify inside the module:
  `go vet ./...`, `go test -race -coverprofile=<tmp> ./...` then
  `go tool cover -func=<tmp>`: every function except the five adapter delegations must
  be at 100 percent (record the raw total too), `go build ./...`,
  `go doc .` lists only the seven exported names.
- [x] 2.6 Verify the root is untouched: `go test ./go/...`,
  `! go list -deps ./go/... | grep -q jackc`, `test ! -e go.sum && test ! -e go.work`.
- [x] 2.7 Commit: `feat(go): add pgxlock advisory-lock adapter as a nested module`.

### Task 3 — real-Postgres integration test (build tag `integration`, local only)

Files: create `go/adapter/pgxlock/pgxlock_integration_test.go`.

- [x] 3.1 Write the test file, first line `//go:build integration`. It reads
  `PGXLOCK_TEST_DATABASE_URL` and fails with a clear message when empty. Cases:
  - held lock keeps one pool connection out; 0 after release; 0 after a not-acquired
    attempt (S13, S24).
  - key compatibility: while the library holds `k`, a separate raw connection running the
    service's literal `SELECT pg_try_advisory_lock(hashtext('job:' || 'k'))` gets `false`;
    after `release()` it gets `true` (S17).
  - second acquire of the same key from the same `Manager` is `false` (S21).
  - after release another `Manager` on another pool can take the lock (S27).
  - cancelling the caller ctx after acquire does not free the lock: the raw connection
    still gets `false` (S4); the later `release()` still unlocks (S23, end to end).
- [x] 3.2 `go vet -tags integration ./...` passes without Postgres.
- [x] 3.3 Start a throwaway `postgres:16` container on a free local port, run
  `PGXLOCK_TEST_DATABASE_URL=... go test -tags integration -count=1 -v ./...`, record the
  command, the pass/fail result and the test count. Never use an existing database.
- [x] 3.4 pgx v5.11.0 compatibility: in a scratch COPY of the module (outside the repo),
  `go get github.com/jackc/pgx/v5@v5.11.0` and rerun the integration test against the same
  container. pgx v5.11.0 needs a newer Go than the local 1.22.4, so this step runs with
  `GOTOOLCHAIN` unset (auto) and records `go version`. If the toolchain cannot be
  obtained, say so plainly. The committed `go.mod` stays on v5.7.4.
- [x] 3.5 Remove the container. Confirm `git diff --exit-code go.mod go.sum` after
  `GOTOOLCHAIN=local go mod tidy`.
- [x] 3.6 Write the commands and results of 3.3 and 3.4 to `evidence.md` in this folder.
- [x] 3.7 Commit: `test(go): add real-Postgres integration test for pgxlock`.

### Task 4 — independent review of Tasks 1 to 3, refactor, re-verify

- [x] 4.1 Dispatch an independent Go reviewer on `git diff 25afcf8 HEAD -- go/` against
  the spec (goroutine safety, connection leaks, context handling, test honesty).
- [x] 4.2 Fix every confirmed finding test-first; rerun the Task 1.4, 2.5 and 3.3 checks.
- [x] 4.3 Commit the fixes (skip the commit only if the review is clean).

### Task 5 — documentation and scripts

- [x] 5.1 `go/README.md`: package-table row for `pgxlock` (separate module); subsection
  `#### Try-or-skip lock manager` under the distributed-lock section showing
  `distlock.Manager`, `NewMemoryManager`, `NewNoopManager`, `pgxlock.New(pool)` and
  stating S13, S17, S18, S25 plus the spare-connection rule; the two `pgxlock` commands in
  `## Testing & Coverage Gate`; the `distlock` row of the package table mentions the
  try-or-skip manager. Wording must NOT claim `ci-go.yml` runs the pgxlock tests.
- [x] 5.2 Root `CLAUDE.md`: name `go/adapter/pgxlock` as the second separate module that
  may hold a third-party dependency; mention the try-or-skip manager next to
  `go/core/distlock`; add the two commands to the commands table.
- [x] 5.3 `scripts/contributor-check.sh`: add the `pgxlock` block next to the gin block.
- [x] 5.4 `scripts/check-go-coverage.sh`: add `go/adapter/pgxlock` to the header comment
  about separate modules (its tests run in `contributor-check.sh`; not yet in
  `ci-go.yml`). No table entry, no threshold change.
- [x] 5.5 Verify: `bash -n` on both scripts, `bash scripts/check-go-coverage.sh`,
  `grep -n 'Try-or-skip lock manager' go/README.md`,
  `grep -n pgxlock scripts/contributor-check.sh`, and run the new block's command once
  by hand (`cd go/adapter/pgxlock && CGO_ENABLED=0 go test ./...` with `GOFLAGS` unset;
  if that cannot load on this Mac, say so). Review the doc diff against the spec
  section 7 list, fix, re-verify.
- [x] 5.6 Commit: `docs(go): document the lock manager and the pgxlock module`.

### Task 6 — final verification and plan tick

- [x] 6.1 Run the full list: `test -z "$(gofmt -l go)"`, `go vet ./go/...`,
  `go test ./go/...`, `bash scripts/check-go-coverage.sh`,
  `bash scripts/check-versions.sh`; in the module `go vet ./...`, `go test ./...`,
  `go vet -tags integration ./...`; `git diff --stat 25afcf8 -- go.mod contracts/` empty;
  `! grep -q 'node-server-decorator/v2 ' go/adapter/pgxlock/go.mod`;
  `! grep -q '^replace' go/adapter/pgxlock/go.mod`;
  `! go list -deps ./go/... | grep -q jackc`; `test ! -e go.sum && test ! -e go.work`;
  the `-race` run of 1.4; in the module `go test -race -cover ./...`,
  `GOTOOLCHAIN=local go mod tidy && go build ./... && git diff --exit-code go.mod go.sum`
  and `go doc .`; `grep -n 'Try-or-skip lock manager' go/README.md`.
- [x] 6.2 Tick this plan and commit: `docs(F-025): mark plan tasks complete`.
- [x] 6.3 `git status --porcelain` empty; `git diff --quiet 25afcf8 HEAD` exits 1.

## Open follow-ups (not in this slice)

- Add the unit step `cd go/adapter/pgxlock && go vet ./... && go test ./...` to
  `.github/workflows/ci-go.yml` (spec 2c; blocked here by the no-workflow-edit rule).
- Release pipeline: tag nested Go modules (`go/adapter/pgxlock/vX.Y.Z`), per the spec's
  design notes.

## Plan audit

Audited once by an independent reviewer subagent (read-only, fresh context) before any
commit. Result: no blockers; 8 should-fix and 3 nits, all folded into the tasks above
(concurrent release, non-nil release on every path, S4 for pgxlock, per-function
coverage check, toolchain note for pgx v5.11.0, honest CI wording, wider final
verification, a named evidence file, red-step wording, running the contributor-check
block, `distlock` description in the docs).

## Execution notes

- Order: the documentation task (Task 5) was committed before the review fixes (Task 4);
  the review ran in parallel with it.
- Review (independent Go reviewer subagent): no blockers. Fixed: session ended when a
  lock or unlock query panics, non-positive timeouts ignored, two-sided deadline
  assertions, lock-query context asserted for a cancelled caller, kill query in the
  failed-unlock integration test scoped to its own lock, close-timeout note on
  `WithUnlockTimeout`.
- Unit-only raw coverage of `pgxlock` is 86.2 percent; everything except the five
  `pgxpool` delegations is at 100 percent. The spec's "at least 90 percent" is met only
  with its stated exclusion of those lines.
- The pgx v5.11.0 run was made before the review fixes and not repeated. See `evidence.md`.
- NOT done, by the no-workflow-edit rule of this run: the `ci-go.yml` unit step.

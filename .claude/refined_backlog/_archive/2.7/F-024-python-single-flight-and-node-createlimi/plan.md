# Python single_flight and Node createLimiter plus keyedSerializer helpers Implementation Plan

Goal (verbatim, epic E-001): "do deep research and synthesize opportunity and pick Tops 5-8 and
fold to EPIC -> do full chain all phases + apply to all active repos ( Test code should not
impact PROD )". This plan covers slice F-024 only. Source of truth: `spec.md` in this folder.

Constraints: additive only; no `contracts/` change; no version bump; no new dependency; tests in
`*.spec.ts` and `python/packages/core/tests/`; nothing exported only for tests.

Numbers in brackets are the spec's behaviour statements (section 3) each test covers.

## Task 1: Node `createLimiter`

- [x] Write `node/packages/core/src/decorators/limiter.spec.ts` first (red):
  - the four fact-board tests ported by name: "never runs more than `max` fns concurrently (2,
    like the claude -p semaphore)" [1, 3: max 2, five tasks, active exactly 2 after one finishes,
    peak 2], "runs queued tasks in FIFO order" [2], "releases the slot when the fn rejects" [6],
    "propagates resolved values" [5]
  - same-tick arrival cannot jump the queue and the count never exceeds max [3]
  - fn is not called synchronously, even with a free slot [4]
  - rejects with the same error object [6]; synchronous throw rejects and frees the slot [7]
  - `RangeError` for 0, -1, 1.5, NaN, Infinity; accepts 1 [8]
  - two limiters share nothing [9]; a never-settling task holds its slot [10]
- [x] Write `limiter.ts` (green).
- [x] Verify: `cd node/packages/core && pnpm test -- --testPathPattern=limiter.spec`.

## Task 2: Node `createKeyedSerializer`

- [x] Write `keyed-serializer.spec.ts` first (red):
  - same key runs one at a time in call order [11]; different keys run in parallel [12]
  - a rejecting task and a synchronously throwing task do not block the key [13]
  - each caller gets its own outcome, never an earlier error [14]
  - fn not called synchronously on an idle key [15]; fn receives no argument after a resolved and
    after a rejected predecessor [16]
  - `unhandledRejection` listener with a positive control sees nothing from the chain [17]
  - `size` is 1 while running, counts keys not tasks, and is 0 after the last task settles
    (success and failure) [18]; two serializers are independent [19]
- [x] Write `keyed-serializer.ts` (green).
- [x] Verify: `pnpm test -- --testPathPattern=keyed-serializer.spec`.

## Task 3: Node exports

- [x] Export `createLimiter`, `Limiter`, `createKeyedSerializer`, `KeyedSerializer` from
  `src/index.ts` under `// Concurrency helpers`.
- [x] Verify: `cd node && pnpm -r run build`, no spec in `dist/decorators`, the `require('./dist')`
  check, and the per-file coverage command (100 percent lines and branches for both files).

## Task 4: Python `SingleFlight`

- [x] Write `python/packages/core/tests/unit/test_single_flight.py` first (red):
  - the four quant `TestFetchOrWait` tests ported (single caller runs once, concurrent callers
    share one call, cleanup after completion, exception reaches all waiters) [21, 24, 26]
  - shared result identity [22]; tuple key [34]; cleanup before callers resume [24]; not cached,
    fn called once more per later call [25]; lookup and registration atomic [23]
  - exception: same instance to all, key removed, retry works [26]; raises before first await and
    plain function that raises [27]; work that raises `CancelledError` reaches all callers [31]
  - cancel first caller, second gets result [28]; cancel later caller, first gets result [28];
    cancel all callers: fn saw `CancelledError`, `len == 0`, nothing logged [29]; fresh work after
    the last-waiter cancel while the old task unwinds [29]
  - silence: loop exception handler, work fails with no caller left, `gc.collect()` [30]
  - clear: running work still delivers, fresh work after clear [32]; cleared work keeps its waiter
    count and is cancelled when its last waiter leaves [32]; cleared work finishing does not
    remove the newer entry [33]
  - contextvars: fn sees the first caller's context [35]; two instances independent [36]
  - statement 37 (one loop, not thread-safe) is a documented limit, not a testable behaviour
- [x] Write `decorators/single_flight.py`; export `SingleFlight` from `server_decorator/__init__.py`
  and `__all__` (green).
- [x] Verify: the four `-k` commands of the spec, the per-file coverage command (100 percent),
  and `uv run python -c "from server_decorator import SingleFlight"`.

## Task 5: READMEs

- [x] `node/packages/core/README.md`: `## Concurrency helpers` before `## Behaviour notes`, one
  example each, statements 3, 4, 8, 13, 15, 18 in one line each.
- [x] `python/packages/core/README.md`: `## Single-flight` before `## Behaviour notes`, one example,
  statements 22, 25, 28, 29, 37 in one line each.
- [x] Root `README.md`: has no per-language feature list, so no change.
- [x] Verify: the two `grep -n` commands of the spec.

## Task 6: Full verification, review, fix

- [x] `cd node && pnpm -r run build && pnpm -r test:unit`; `cd python && bash scripts/check.sh`;
  `go test ./go/...`; `bash scripts/check-versions.sh`; `bash contracts/scripts/validate.sh`;
  `git diff --stat release/2.7 -- contracts/ node/packages/core/package.json python/packages/core/pyproject.toml`
  prints nothing.
- [x] Independent review of the diff (TypeScript and Python reviewers); fix every finding; re-run
  the full verification.
- [x] Commit in logical units; tree clean.

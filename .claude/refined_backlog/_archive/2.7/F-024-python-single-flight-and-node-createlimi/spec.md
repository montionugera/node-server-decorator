---
title: "Python single_flight and Node createLimiter plus keyedSerializer helpers"
id: F-024
status: refined
from_idea: I-027
---

# Python single_flight and Node createLimiter plus keyedSerializer helpers

Slice of epic E-001 (verified adoptions). Python and Node. Target branch: `release/2.7`.

## 1. Problem

Two services hand-write three small concurrency helpers. The library has batch loaders
(`batch_load`, `batchLoad`) but they do not fit: none of the three sites batches.

| Service | File | Lines | What it is |
|---|---|---|---|
| fact-board | `src/lib/server/drafter/limiter.ts` | 46 | `createLimiter(max)`: first-in first-out concurrency limiter |
| fact-board | `tests/unit/claude-spawn-limiter.test.ts` | 68 | Four tests of the limiter |
| fact-board | `src/lib/server/renderer/comfyui.ts:82-94` | 13 | `serializeComfy(key, fn)`: one promise chain per key |
| quant | `quant-api/src/workers/ohlc_quarter_cache.py:337-376` | 40 | `_INFLIGHT` map and `fetch_or_wait`: keyed single-flight. Also `_INFLIGHT.clear()` at line 330 |
| quant | `quant-api/tests/unit/test_ohlc_quarter_cache.py:291-357` | 67 | `TestFetchOrWait`, four tests |

Callers:

- `createLimiter`: `fact-board/src/lib/server/drafter/claude-code.ts:93` (production) and
  `tests/unit/claude-breaker.test.ts:150` (a test of something else that needs a limiter).
- `serializeComfy`: `comfyui.ts:189` only.
- `fetch_or_wait`: `quant-api/src/workers/bar_streamer.py:213` only.

## 2. Public API

### 2a. Node: limiter

File `node/packages/core/src/decorators/limiter.ts`. Exported from
`node/packages/core/src/index.ts` under a new comment block `// Concurrency helpers`.

```ts
/** Runs fn when a slot is free and resolves or rejects with fn's outcome. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Admit at most `max` concurrent fn executions. Extra callers queue first-in first-out.
 * @throws RangeError when max is not an integer >= 1.
 */
export function createLimiter(max: number): Limiter;
```

### 2b. Node: keyed serializer

File `node/packages/core/src/decorators/keyed-serializer.ts`. Exported from the same block.

```ts
export interface KeyedSerializer {
  /** Runs fn after every earlier task for the same key has settled. */
  <T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Number of keys that have a task queued or running. */
  readonly size: number;
}

/** Each call returns an independent serializer with its own key space. */
export function createKeyedSerializer(): KeyedSerializer;
```

### 2c. Python: single-flight

File `python/packages/core/src/server_decorator/decorators/single_flight.py`. Exported as
`SingleFlight` from `server_decorator/__init__.py` and added to `__all__`.

```python
K = TypeVar("K", bound=Hashable)
V = TypeVar("V")

class SingleFlight(Generic[K, V]):
    """Keyed single-flight for asyncio: one execution per key while it is in flight."""

    def __init__(self) -> None: ...

    async def do(self, key: K, fn: Callable[[], Awaitable[V]]) -> V:
        """Run fn once per key. Callers that arrive while it runs share its outcome."""

    def clear(self) -> None:
        """Forget every in-flight key. Running work continues while callers wait."""

    def __len__(self) -> int:
        """Number of keys currently in flight."""
```

`asyncio` only (Decision #10). Python 3.10 or newer, as the package already requires.
Fully typed, `mypy --strict` clean.

## 3. Behaviour contract

"Differs" marks where the service does something an obvious implementation would not, or
where this spec deliberately departs from the service.

### Node `createLimiter`

1. At most `max` calls to `fn` are running at any time.
2. Callers beyond `max` wait in first-in first-out order. With `max = 1` and tasks 1, 2,
   3, 4 submitted in that order, they start in that order.
3. **Differs.** When a task finishes, its slot is handed to the first waiter
   synchronously, inside the release step. The active count goes from `max` to `max - 1`
   and back to `max` in one synchronous step. A caller that arrives in the same tick
   cannot take the slot ahead of the queue, and the count never exceeds `max`.
4. **Differs.** `fn` is never called synchronously inside the limiter call, even when a
   slot is free. It starts on a later microtask.
5. The returned promise resolves with the value `fn` resolved with.
6. If `fn` rejects, the returned promise rejects with the same error object, and the slot
   is released. The next caller runs.
7. If `fn` throws synchronously, the result is the same as statement 6.
8. **Differs from the service.** `createLimiter(max)` throws `RangeError` when `max` is
   not an integer of at least 1 (0, negative, fractional, `NaN`, `Infinity`). The service
   does no check: `max = 0` or `NaN` makes every caller wait forever, and `max = 1.5`
   admits two. The service caller already clamps to an integer of at least 1
   (`claude-code.ts:90-92`), so no working call changes.
9. Two limiters made by two `createLimiter` calls share nothing.
10. There is no queue bound, no timeout and no cancellation. A task that never settles
    holds its slot forever.

### Node `createKeyedSerializer`

11. Tasks with the same key run one at a time, in call order.
12. Tasks with different keys do not wait for each other. Two keys can run in parallel.
13. A task that rejects, or throws synchronously, does not block the key. The next task
    for that key still runs.
14. The returned promise resolves or rejects with the outcome of that caller's own `fn`.
    A caller never sees an earlier task's error.
15. **Differs.** `fn` is never called synchronously inside the serializer call, even when
    the key is idle. It starts on a later microtask.
16. **Differs from the service.** `fn` is called with no arguments. The service does
    `prev.then(fn, fn)`, which passes the previous task's value or error to `fn` as an
    argument. The type hides it. The library must call `() => fn()`.
17. The internal chain never causes an `unhandledRejection`. If the caller ignores a
    rejected returned promise, that is the caller's own unhandled rejection, as usual.
18. **Differs from the service.** When the last task of a key settles, the key is removed
    from the internal map. The service never deletes a key, so its map grows by one entry
    per distinct key for the life of the process. `size` is 0 when nothing is queued or
    running.
19. Two serializers made by two `createKeyedSerializer` calls share nothing. The same key
    in each is independent.
20. There is no timeout and no cancellation.

### Python `SingleFlight`

21. While work for a key is in flight, every `do(key, fn)` call shares it. `fn` is called
    exactly once. With three concurrent callers, the call count is 1.
22. All callers receive the same result object (`is`, not a copy). A caller that mutates
    it changes what the others see. Same as the service.
23. There is no await between the lookup and the registration of a key. Two callers can
    never both start work for the same key.
24. The key is removed when the work finishes: on success, on exception and on
    cancellation of the work. It is removed before any caller resumes. Right after
    `await sf.do(k, fn)` returns or raises, `len(sf) == 0`.
25. Nothing is cached. A `do` call that starts after the work finished calls `fn` again.
26. If `fn` raises, every caller gets the same exception instance, the key is removed,
    and the next `do` call retries.
27. A `fn` that raises before its first await (including a plain function that raises
    instead of returning an awaitable) behaves as in statement 26.
28. **Differs from the service.** The work runs in its own task, started by the first
    caller, and waiters are counted. Each caller awaits `asyncio.shield(task)`.
    Cancelling one caller, the first or a later one, raises `CancelledError` in that
    caller only; a cancelled caller never breaks the others. The shared work keeps
    running while at least one caller is still waiting, and the remaining callers
    receive its result. (The service runs the work inside the first caller. There,
    cancelling the first caller leaves the shared future unresolved and **every other
    caller waits forever**. Cancelling a later caller cancels the shared future, so the
    first caller then fails with `InvalidStateError` and the others get `CancelledError`.)
29. **Differs from the service.** When the last waiting caller is cancelled, the shared
    work is cancelled: the entry is removed from the internal map (using an identity check
    so a newer entry for the same key is not removed) and `task.cancel()` is called. A
    `do()` arriving after the last-waiter cancel starts fresh work even if the old task is
    still unwinding.
30. An exception from the work that no caller is left to receive (including when the last
    waiter is cancelled) is consumed silently. asyncio must not log "Task exception was
    never retrieved" or "Future exception was never retrieved". The service logs that
    warning whenever a fetch fails with no second caller waiting.
31. If the work itself is cancelled (it raises `CancelledError`), every caller gets
    `CancelledError` and the key is removed. No caller hangs.
32. `clear()` forgets all keys at once. Work already running is not cancelled immediately
    and still delivers to the callers already attached. Work that was cleared keeps its
    waiter count and is still cancelled when its last waiter leaves. A `do` call after
    `clear()` starts fresh work even if the old task is still unwinding.
33. **Differs from the service.** Forgotten work that finishes later must not remove a
    newer entry under the same key. Remove a key only if the entry is still the one this
    work registered. The service does `pop(key, None)` and would remove the newer entry.
34. Any hashable key works. The quant key is a tuple of three strings.
35. `fn` runs in a copy of the first caller's `contextvars` context (normal task
    behaviour). Later callers' context is not visible to it.
36. Two `SingleFlight` instances share nothing.
37. One instance belongs to one event loop. It is not safe across threads.

## 4. Non-goals

- No Go helper. `go/core/coalesce.Group` already exists.
- No result caching, no time-to-live, no negative caching.
- No timeout, no queue bound, no abort signal, no priority in any of the three helpers.
- No decorator form (`@single_flight`, `@limit`) and no class-form variant.
- No synchronous Python variant and no thread-based variant. No `trio` / `anyio`.
- No Python limiter or serializer, and no Node single-flight. No site needs them.
- No non-string keys for the Node serializer.
- No distributed (cross-process) behaviour. All three are in-process.
- No change to `batch_load` / `batchLoad`, and no reuse of their internals.
- No version bump and no change under `contracts/`.

## 5. Compatibility

- Additive only. Three new source files and new exports. No existing export changes.
- New export names: Node `createLimiter`, `Limiter`, `createKeyedSerializer`,
  `KeyedSerializer`; Python `SingleFlight`. None exists today in
  `node/packages/core/src/index.ts` or `server_decorator/__init__.py`.
- No `contracts/` change. These helpers have no wire format, so no cross-language parity
  fixture applies.
- No new dependency in `node/packages/core/package.json` or
  `python/packages/core/pyproject.toml`.
- Node coverage gate: `node/packages/core/jest.config.js`,
  `coverageThreshold: { global: { lines: 98, branches: 88 } }`, enforced by
  `cd node && pnpm -r test:unit` (`jest --selectProjects unit --coverage`). The two new
  files must reach 100 percent lines and branches so the global number does not drop;
  because the global gate does not enforce per-file thresholds, a dedicated acceptance
  command prints per-file coverage and requires 100 percent lines for the new files.
- Python coverage gate: `python/packages/core/scripts/check.sh`, `COV_MIN=98` (line plus
  branch), run by `cd python && bash scripts/check.sh`, together with `ruff check`,
  `ruff format --check` and `mypy src` (strict). The new file must reach 100 percent lines,
  enforced by a dedicated acceptance command printing per-file coverage.
- Do not lower either threshold.

## 6. Test code stays out of production

- Node tests: `node/packages/core/src/decorators/limiter.spec.ts` and
  `keyed-serializer.spec.ts`, next to the source, as the package does today.
  `tsconfig.json` excludes `**/*.spec.ts` from the build and `package.json` publishes
  only `dist/`, so no spec file is shipped.
- Python tests: `python/packages/core/tests/unit/test_single_flight.py`. The wheel
  packages only `src/server_decorator` (`pyproject.toml`, `packages = ["src/server_decorator"]`),
  so `tests/` is not shipped.
- No fake, deferred-promise helper, gate or clock is exported. Test helpers stay inside
  the spec and test files.
- `KeyedSerializer.size` and `SingleFlight.__len__` are production surface (queue-depth
  metrics), not test hooks. They are the only way cleanup is observable, and the tests
  use them.

## 7. Documentation to update

- `node/packages/core/README.md`: add a section `## Concurrency helpers` before
  `## Behaviour notes`, with one example each for `createLimiter` and
  `createKeyedSerializer`. State statements 3, 4, 8, 13, 15 and 18 in one line each.
- `python/packages/core/README.md`: add a section `## Single-flight` before
  `## Behaviour notes`, with one `SingleFlight().do(key, fn)` example. State statements
  22, 25, 28 (shared work runs while callers wait), 29 (shared work cancelled when last
  waiter leaves) and 37 in one line each.
- Root `README.md`: if it has a feature list per language, add the three helpers there.

## 8. Acceptance criteria

- [ ] `cd node && pnpm -r test:unit` passes, with the global coverage threshold in `node/packages/core/jest.config.js` unchanged at lines 98 / branches 88.
- [ ] `cd node && pnpm -r run build` passes, and `! ls node/packages/core/dist/decorators | grep -q spec`.
- [ ] Per-file coverage for Node new files: `cd node/packages/core && pnpm test -- --coverage --collectCoverageFrom='src/decorators/limiter.ts' --collectCoverageFrom='src/decorators/keyed-serializer.ts'` prints per-file coverage and requires 100 percent lines for both files.
- [ ] `cd python && bash scripts/check.sh` passes (ruff, ruff format, mypy strict, pytest with `COV_MIN=98` unchanged).
- [ ] Per-file coverage for Python new files: `cd python/packages/core && uv run pytest --cov=server_decorator.decorators.single_flight --cov-report=term-missing tests/unit/test_single_flight.py` prints per-file coverage and requires 100 percent lines for single_flight.py.
- [ ] `go test ./go/...` passes from the repo root (no Go file changed; this proves nothing else broke).
- [ ] `bash scripts/check-versions.sh` passes (no version changed).
- [ ] `git diff --stat release/2.7 -- contracts/ node/packages/core/package.json python/packages/core/pyproject.toml` prints nothing.
- [ ] Limiter concurrency and order: `cd node/packages/core && pnpm test -- --testPathPattern=limiter.spec` passes and covers statements 1 to 4, including a test with `max = 2` and five tasks that asserts the active count is exactly 2 after one task finishes and the peak is 2.
- [ ] Limiter outcomes: the same command covers statements 5 to 7 and 9 (value passes through, same error object rejects, slot freed after a rejection and after a synchronous throw).
- [ ] Limiter validation: the same command covers statement 8 with `0`, `-1`, `1.5`, `NaN` and `Infinity`, each throwing `RangeError`.
- [ ] The four tests of `fact-board/tests/unit/claude-spawn-limiter.test.ts` are ported by name into `limiter.spec.ts` and pass unchanged apart from imports and test-runner globals.
- [ ] Serializer order: `cd node/packages/core && pnpm test -- --testPathPattern=keyed-serializer.spec` passes and covers statements 11, 12, 15 and 19.
- [ ] Serializer errors: the same command covers statements 13, 14, 16 and 17, including a test that fails if `fn` receives any argument and a test that registers a `process.on('unhandledRejection')` listener with a positive control (a deliberately unhandled rejection that the listener must catch to prove it is active) and sees no event from the chain.
- [ ] Serializer cleanup: the same command covers statement 18: `size` is 1 while a task runs and 0 after the last task for every key settles.
- [ ] Single-flight sharing: `cd python/packages/core && uv run pytest tests/unit/test_single_flight.py -q -k "share or once or identity or cleanup"` passes and covers statements 21 to 25 and 34 (with a tuple key).
- [ ] Single-flight errors: `uv run pytest tests/unit/test_single_flight.py -q -k "exception or raises"` passes and covers statements 26, 27 and 31.
- [ ] Single-flight cancellation: `cd python/packages/core && uv run pytest tests/unit/test_single_flight.py -q -k cancel` passes and covers statements 28 and 29: one test cancels the first caller and asserts the second caller still gets the result; one cancels a later caller and asserts the first still gets the result; one cancels all callers and asserts `fn` observed `CancelledError`, `len(sf) == 0` afterwards, and nothing was logged.
- [ ] Single-flight silence: a test covers statement 30 by installing a loop exception handler, failing the work with no caller left, forcing `gc.collect()`, and asserting the handler was never called.
- [ ] Single-flight clear: `uv run pytest tests/unit/test_single_flight.py -q -k clear` passes and covers statements 32 and 33.
- [ ] Single-flight clear and waiter cancel: a test asserts that work cleared via `clear()` keeps its waiter count and is cancelled when its last waiter leaves, covering statement 32.
- [ ] Single-flight fresh work after cancel: a test asserts that a `do()` arriving after the last-waiter cancel starts fresh work even if the old task is still unwinding, covering statement 29.
- [ ] The four tests of quant `TestFetchOrWait` are ported into `test_single_flight.py` (single caller, concurrent callers share one call, cleanup after completion, exception reaches all waiters) and pass.
- [ ] `cd python/packages/core && uv run python -c "from server_decorator import SingleFlight"` exits 0.
- [ ] `cd node/packages/core && node -e "const m=require('./dist');if(typeof m.createLimiter!=='function'||typeof m.createKeyedSerializer!=='function')process.exit(1)"` exits 0 after the build.
- [ ] `grep -n 'Concurrency helpers' node/packages/core/README.md` and `grep -n 'Single-flight' python/packages/core/README.md` each find the new section.

## 9. Adoption check

Once this ships, these service files and blocks should be deletable.

**fact-board**

- `src/lib/server/drafter/limiter.ts` (46 lines). `claude-code.ts:9` and
  `tests/unit/claude-breaker.test.ts:12` import `createLimiter` from the library instead.
- `tests/unit/claude-spawn-limiter.test.ts` (68 lines).
- `src/lib/server/renderer/comfyui.ts:82-94`: the `comfyChains` map and `serializeComfy`.
  Replace with `const serializeComfy = createKeyedSerializer();`. The call at line 189
  keeps its shape `serializeComfy(this.serialKey, () => this.renderOnce(req))`.

**quant**

- `quant-api/src/workers/ohlc_quarter_cache.py:337-376`: the `_INFLIGHT` map and the body
  of `fetch_or_wait`. Replace with a module-level `SingleFlight` and a one-line
  `fetch_or_wait` that calls `do((symbol, interval, quarter_id), fetcher)`, or call `do`
  directly from `bar_streamer.py:213`.
- Line 330, `_INFLIGHT.clear()` inside `clear()`: becomes a call to `SingleFlight.clear()`.
- `quant-api/tests/unit/test_ohlc_quarter_cache.py:291-357`: `TestFetchOrWait`. Two of its
  tests read `cache._INFLIGHT` directly; they move to the library as `len(sf) == 0`.

## Design notes

- **Class, not a module function, for Python.** The slice title says `single_flight`. A
  module-level `single_flight(key, fn)` needs a process-global registry. Unrelated callers
  would then share a key space, and quant's `clear()` (line 330) could not reset only its
  own entries. `SingleFlight` instances fix both. The method is `do`, matching
  `coalesce.Group.Do` in Go.
- **`clear()` and `__len__` exist because quant needs them.** `clear()` replaces
  `_INFLIGHT.clear()`. `__len__` replaces the service tests' direct reads of the map.
- **`createKeyedSerializer`, not a shared `keyedSerializer`.** Same reason: the service
  keeps one module-level map; a factory gives each consumer its own. Named to match
  `createLimiter`.
- **`size` on the serializer** was added so statement 18 (key cleanup) can be tested
  without a test-only export.
- **Limiter validation** (statement 8) and **serializer key cleanup** (statement 18) are
  improvements over the service. Neither changes a working call.
- **Cancellation semantics are a deliberate behaviour change for quant** (statements 28
  and 29). The service behaviour there is a latent hang, so "no behaviour loss" cannot
  mean copying it. Under the owner decision, shared work runs while at least one caller
  is waiting, but is cancelled when the last waiting caller leaves (`task.cancel()`).
  This resolves the risk of detached fetches holding closed caller-scoped resources.
- **Open: two new dependencies.** Neither fact-board nor quant depends on the library
  today. Each adoption adds the dependency for 40 to 60 lines. That is an adoption
  decision, not a library one.

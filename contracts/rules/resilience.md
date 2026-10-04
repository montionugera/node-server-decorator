# Resilience decorators — shared behaviour rules

Applies to `retry`, `circuitBreaker` / `circuit_breaker` and `rateLimit` / `rate_limit`
in every lane that ships them (Node, Python, Go). These decorators are process-local:
nothing here crosses the wire, so the rules pin observable behaviour, not a byte format.

## Retry — `maxAttempts`

- `maxAttempts` is the total number of calls, including the first. It must be an
  **integer >= 1**.
- Omitted (Node `undefined`, Python default, Go zero value `0`) means the default, **3**.
- Any other value is a configuration error raised **when the decorator is applied**, never
  at call time: Node throws `RangeError` (`0`, negatives, `NaN`, `Infinity`, fractions);
  Python raises `ValueError` (`0`, negatives, non-`int`, `bool`); Go panics on a negative
  value (its `int` type already excludes the rest, and `0` is the unset zero value).
- The wrapped method always runs at least once. When the last attempt fails, its error
  propagates; a retry wrapper never resolves with an empty result in place of an error.

## Circuit breaker — half-open probes

- In `half-open`, at most `halfOpenSuccessThreshold` calls (probes) may be in flight at
  once. Further calls are rejected exactly as in `open` (open error, or the fallback).
- A probe slot is released when that probe's result is recorded. If every slot has been
  held for longer than the recovery timeout without a result, the slots are treated as
  abandoned and reclaimed, so a hung probe cannot wedge the breaker.
- Only results of calls admitted in the breaker's **current** state count. A call admitted
  before a state transition (for example, admitted while `closed`, finishing after the
  breaker has tripped and half-opened) is stale: its result is ignored and can neither
  close nor re-open the breaker.
- Calling the low-level `allowRequest` in `half-open` takes a probe slot; pair it with one
  `recordSuccess` / `recordFailure`.

## Clocks

- Recovery timeouts and token refill use a **monotonic** clock (Node `performance.now()`,
  Python `time.monotonic()`, Go's monotonic reading in `time.Now()`), never the wall clock.
- Elapsed time is clamped to `>= 0`; a token bucket's token count never goes negative.

## Rate limit — registry (Node, Python)

- The default bucket key is `<ClassName>.<method>`; for a static method the class name is
  the class itself (never `Function`).
- Idle buckets are evicted. A bucket that has refilled to capacity is indistinguishable
  from a new one, so it may be dropped at any time; a bucket below capacity is never
  evicted. Lanes sweep when the registry reaches 1024 entries, then again each time it
  doubles past what survived the last sweep.

## Circuit breaker — registry (Node, Python)

- The default breaker name is `<ClassName>.<method>`, with the same static-method rule.
- A decorated method resolves its breaker from the registry **on every call**. After the
  registry is cleared, the next call registers a fresh `closed` breaker with that
  decorator's options, so the registry always reports the breaker the method uses.
- When a decorator is applied under a name already registered with different thresholds,
  the first registration wins and a warning is logged through the library logger.

Go has no registries: breakers and limiters are passed explicitly, so the two registry
sections do not apply there.

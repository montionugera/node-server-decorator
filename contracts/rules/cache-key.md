# `cache-key` (contract v1.0.0)

Deterministic algorithm for building the key passed to `CacheAdapter.get` / `CacheAdapter.set` from `@cache` / `cache_class`. Locked by Decision #6.

## Algorithm

Given:

- `qualname` — `ClassName.methodName` for class methods; `methodName` alone for free functions.
- `args` — positional arguments to the wrapped call (excluding `self`/`cls`).
- `kwargs` — keyword arguments (may be empty).

Produce:

```
raw = qualname + "(" + arg_repr + ")"

arg_repr =
    join(",", [reprArg(a) for a in args])
    + (if kwargs: "," + join(",", [k + "=" + reprArg(kwargs[k]) for k in sorted(kwargs.keys())]))

reprArg(x) =
    JSON.stringify(x, sortKeys=True, defaultEncoder=str)
    -- Python: json.dumps(x, sort_keys=True, default=str)
    -- Node:   stableStringify(x) (canonical JSON; see node/packages/core/src/decorators/_cache_key.ts)

if utf8_byte_len(raw) <= 250:
    return raw
else:
    digest = sha256(raw, encoding="utf-8").hex()
    return qualname + "(sha256:" + digest + ")"
```

## Why these choices

- **Stable key ordering** — JSON.stringify and `json.dumps` order keys non-deterministically by default in some implementations; `sort_keys=True` makes the output reproducible.
- **`default=str`** — non-JSON-serializable args (e.g. `Date`, `datetime`, `Decimal`) get coerced to their string representation rather than raising. The cache key is allowed to be lossy (two args with the same `str()` collide); the value contract is `eq → same key`, not `same key → eq`.
- **250-byte cap** — Redis and most KV stores truncate or reject very long keys. SHA-256 hex (64 bytes) plus the `qualname(sha256:)` wrapper keeps the key bounded while preserving readability for short cases.
- **No timestamp / nonce** — the same call with the same args MUST produce the same key, otherwise `@cache` does nothing.

## Examples

(See `contracts/fixtures/cache-key.examples.json` for the executable form.)

| qualname | args | kwargs | expected key |
|----------|------|--------|--------------|
| `OrderService.create` | `["cust-1", 42.0]` | `{}` | `OrderService.create("cust-1",42.0)` |
| `OrderService.create` | `[{"a": 1, "b": 2}]` | `{}` | `OrderService.create({"a":1,"b":2})` |
| `OrderService.create` | `[]` | `{"customer_id": "cust-1"}` | `OrderService.create(customer_id="cust-1")` |
| `OrderService.create` | `[]` | `{"b": 2, "a": 1}` | `OrderService.create(a=1,b=2)` *(kwargs sorted)* |
| `formatDate` | `[<Date 2026-05-08T...>]` | `{}` | `formatDate("2026-05-08T...")` *(default=str coercion)* |
| `<long input over 250 bytes>` | `[<huge dict>]` | `{}` | `qualname(sha256:abc...64hex)` |

## Edge cases

- **Empty args + empty kwargs** → `qualname()`.
- **`None`/`null` arg** → JSON `null` → `qualname(null)`. (Distinct from caching a `None` *value*, which is governed by `cache-adapter.md`.)
- **Self-referential / circular structures** → `JSON.stringify` and `json.dumps` raise; the decorator MUST surface this error rather than silently producing a different key.
- **Unicode in args** → encoded UTF-8 for the byte-length check; the key string itself stays UTF-8.
- **String escaping** → strings (values and object keys) are written exactly as JavaScript `JSON.stringify` writes them: only `"`, `\` and C0 control characters are escaped (`\b \f \n \r \t`, otherwise `\u00xx` lowercase hex). Non-ASCII characters, `<`, `>`, `&`, U+2028 and U+2029 are written literally. Python therefore passes `ensure_ascii=False`, and Go uses its own string quoter instead of `encoding/json` (which HTML-escapes). Pinned by the `unicode-arg-stays-utf8`, `html-chars-not-escaped` and `control-and-separator-chars` fixtures.
- **Receiver** → `self`/`cls` is never part of `args`. Python detects a method by its first parameter being named `self` or `cls` and drops that positional argument; Node never sees `this` in `args`.
- **Float NaN / Infinity** → not JSON-serializable per spec. Every implementation MUST surface an error to the caller before the adapter or the wrapped function is touched: Python passes `allow_nan=False` (`ValueError`), Node throws a `TypeError`, Go returns an error wrapping `ErrNonFiniteCacheArg` from `BuildCacheKeyE` / `Cache` (`BuildCacheKey` panics with it).
- **Non-plain objects (Node)** → `default=str` has no direct JS equivalent, so `stableStringify` maps: `Date` → its `toISOString()` string (an invalid `Date` throws); `Map` → an object of its entries with `String(key)` keys; `Set` → an array of its members, sorted by their serialised form; any object with a `toJSON()` → the serialisation of its result; any other object that has no own enumerable keys and is not a plain object (`RegExp`, `Error`, …) → `String(x)`. Plain objects and class instances serialise by their own enumerable keys. The *text* of a date still differs per language (Node ISO-8601 with `Z`, Python `str(datetime)`, Go RFC 3339), so date-typed args are not portable across languages — pass an already-formatted string when a key must be shared.
- **Whole-number floats** (e.g. `42.0`, `100.0`) → JS has no integer/float distinction at the JSON layer (`JSON.stringify(42.0) === "42"`), while Python writes `42.0`. As a result, an arg of `42.0` in Python produces a different cache key than `42.0` in Node. Cross-language consumers should treat all numeric args as canonical integers when whole-valued, OR restrict cache keys to a single language. This is an irreducible JSON edge case, not a bug.

## Migration note (v2.0.0)

The pre-v2.0.0 Node code used `args.join(',')` (e.g. `[1,[2,3]] → "1,2,3"`), which conflated nested arrays and was not language-portable. The v2.0.0 algorithm is the contract above. Per **D-A**, every existing cached entry on a Node consumer becomes a miss on first access after upgrade. Operators with hot caches MUST flush the cache namespace before deploying v2.0.0 in any non-trivial environment, or accept a brief miss spike.

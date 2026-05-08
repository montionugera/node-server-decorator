# `tracking-key` (contract v1.0.0)

## Format

The first argument to `global_tracker.track(key, latency_ms, is_error)` is built as:

```
ClassName.methodName     -- when the decorated callable is a method on a class
methodName               -- when the decorated callable is a free function
```

Implementation:
- **Node:** `${target.constructor.name}.${propertyKey}` for methods. Free functions are not currently supported by Node `@tracking` (always-async, decorator-on-method only).
- **Python:** `fn.__qualname__`, which gives `ClassName.methodName` for methods (last two segments — outer/nested classes collapsed) and `methodName` for free functions. The class form `tracking_class()` walks `vars(cls)` so qualnames stay consistent.

## Why no args in the key

`@tracking` measures latency per *method*, not per *call*. Including args would create cardinality explosion in observability backends (one tracker key per unique input). If you need per-input tracking, build it on top of `@tracking` rather than parameterizing the key.

## Examples

| Callable | Key |
|----------|-----|
| `class Foo: def bar(): ...` | `Foo.bar` |
| `class Foo: async def bar(): ...` | `Foo.bar` |
| `def free_function(): ...` (Python) | `free_function` |
| `class Outer: class Inner: def m(): ...` | `Inner.m` *(Python: `__qualname__.rsplit('.', 2)[-2:]`)* |

## v2.0.0 additions

The `TrackingEvent` JSON schema now includes an optional `ts` field (epoch-ms). Both implementations populate it in v2.0.0; consumers tracking events via `global_tracker.track()` get the timestamp from there.

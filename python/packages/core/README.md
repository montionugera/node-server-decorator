# server-decorator (Python)

Server-side decorators for caching, tracking, and queue emission. Polyglot sibling of the Node `server-decorator` npm package — both share the wire-format contracts in [`../../../contracts`](../../../contracts).

## Install

```bash
pip install server-decorator               # core
pip install server-decorator[redis]        # + redis adapter
pip install server-decorator[rabbitmq]     # + aio-pika adapter
pip install server-decorator[kafka]        # + aiokafka adapter
pip install server-decorator[all]          # all adapters
```

Requires Python 3.10+. `asyncio` only — no `trio`/`anyio` (Decision #10).

## Quick start

### Method form

```python
from server_decorator import tracking, cache, emit_on_success, CACHE_MISS

class InMemoryCache:
    def __init__(self): self._d = {}
    def get(self, key): return self._d.get(key, CACHE_MISS)
    def set(self, key, val, ttl): self._d[key] = val

class OrderService:
    @tracking
    @cache(InMemoryCache(), ttl=300)
    @emit_on_success(use_events=True)
    async def create_order(self, customer_id: str, total: float) -> dict:
        return {"customer_id": customer_id, "total": total, "status": "pending"}
```

### Class form (auto-wrap every public method)

```python
from server_decorator import tracking_class

@tracking_class()
class OrderService:
    async def create_order(self, ...): ...    # auto-wrapped
    async def cancel_order(self, ...): ...    # auto-wrapped
    def _internal(self): ...                  # SKIPPED (leading underscore)
```

`tracking_class`, `cache_class`, and `emit_on_success_class` accept `include`, `exclude`, and `include_private` to override the default predicates.

## Sync vs async

Method-level decorators auto-detect coroutines via `inspect.iscoroutinefunction` and wrap accordingly (Decision #5). For `@emit_on_success(use_queue=True)` on a sync method called outside an event loop, the side effect runs on a single-worker `ThreadPoolExecutor` so the caller doesn't block (D-C). To drain in-flight emits at process exit:

```python
import atexit
from server_decorator.decorators.emit_on_success import _EMIT_EXECUTOR
atexit.register(_EMIT_EXECUTOR.shutdown, wait=True)
```

## Caching `None` / falsy values

`CacheAdapter.get` returns `CACHE_MISS` (a module-level sentinel) when a key is absent — `None`/`0`/`""`/`False` are valid cached values. See [`../../../contracts/rules/cache-adapter.md`](../../../contracts/rules/cache-adapter.md).

## License

MIT.

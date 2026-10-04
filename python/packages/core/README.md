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

## Consuming events

```python
from server_decorator import ConsumerRegistry, on_event, RedisStreamConsumer
import redis.asyncio as redis

registry = ConsumerRegistry()
registry.register(
    "orders",
    RedisStreamConsumer(redis.from_url("redis://localhost:6379"), stream="orders", group="email-svc"),
)

@on_event("OrderService.createOrder", consumer="orders")
async def send_email(payload, meta):
    ...  # return -> ack; raise -> redelivered

await registry.start()
# ... app runs ...
await registry.stop()
```

**Delivery is at-least-once.** A message can be delivered more than once (e.g. a
crash between handler success and ack). **Handlers must be idempotent.** Ordering
is not guaranteed under redelivery. Unparseable messages are acked + skipped;
only handler failures stay pending for retry.

### Available consumers

| Consumer | Dependency |
|----------|------------|
| `RedisStreamConsumer` | `pip install server-decorator[redis]` |
| `KafkaConsumer` | `[kafka]` |
| `RabbitMQConsumer` | `[rabbitmq]` |
| `BullMQConsumer` | `[bullmq]` |

All backends deliver **at-least-once**, so handlers must be idempotent; failed
messages stay pending/unacked (Redis/RabbitMQ) or are retried per attempts
(Kafka offset is not committed / BullMQ job `attempts`).

`KafkaConsumer` rewinds the partition to a failed offset after
`retry_backoff_ms` (default 1000 ms), so the record is redelivered before
anything later is committed. A record that always fails therefore blocks its
partition; route it to a dead-letter topic inside the handler if that is not
what you want.

A traced message is handled inside its own exported span, named
`consume <eventName>` (`span.kind = CONSUMER`), whose parent is the producer
span. Inside the handler `span_id` is that consumer span's id, and the caller's
previous trace context is restored after dispatch.

## Behaviour notes

- **Auto topic.** The auto-generated topic is always `ClassName.methodName`,
  also when `event_name` is overridden (it used to follow the event name).
  If you set `event_name` without `topic`, the topic changes, e.g.
  `order.created` becomes `OrderService.create`: update consumer bindings or
  pin `topic=`.
- **Emit never changes the method's outcome.** If `transform` raises, the error
  is logged and both the event and the queue publish are skipped; the caller
  still gets the method's result.
- **Sync emit outside an event loop** publishes on one long-lived loop on the
  single emit worker thread (closed at exit) and carries the caller's
  `traceparent` / `tracestate`.
- **Lost lock lease.** `@distributed_lock` raises `LockLostError` after the
  method settles if the lease was lost while it ran (the method's own error, if
  any, is its `__context__`). A renewal that errors is retried on the next tick;
  the lease counts as lost on a definite refusal or after a full TTL with no
  confirmed renewal. The token-guarded release is always attempted, and a
  cancellation in flight is never replaced or swallowed.
  `distributed_lock_class` wraps coroutine functions only; sync methods and
  properties are left untouched.
- **Tracing.** A `traceparent` must be version `00` with lower-case hex;
  anything else is ignored and a new trace starts. `@trace` on a generator or
  async generator spans the whole iteration. A plain function (or callable object)
  that returns a coroutine or an async-generator object keeps its span open until
  that object is awaited / fully iterated, with the trace context active in the
  body and failures recorded; if the returned object is never awaited no span is
  exported. A returned `asyncio.Future`/`Task` or a plain generator object returned
  from a non-generator function is not tracked (the span ends when the function
  returns) - decorate the inner function instead. Cancellation and other
  `BaseException`s export the span as `ERROR` and are re-raised unchanged.
- **Batch load receiver detection.**
  - Name the receiver `self` or `cls`. Then it is always recognised.
  - With another receiver name, the owner class is found by scanning the class for the decorated function through `__wrapped__` / `__func__`. A decorator stacked on top that sets neither hides it, and the instance is then treated as the key. The result is cached per class.
  - A `@staticmethod` is never given a receiver.
- **Cache.** A failing adapter `set` is logged and the result is still
  returned; a failing `get` propagates. Non-finite numbers are rejected in
  plain JSON values, dict/list/tuple/set/frozenset/deque, dataclass instances,
  Decimal and complex; any OTHER object is keyed by `str(obj)` without being
  inspected, so give such objects a stable `__str__` or pass a plain value.
  Set and frozenset arguments are keyed as a sorted list. Keys keep non-ASCII
  text as UTF-8 (matching Node).

## Development

`bash scripts/check.sh` runs ruff, ruff format, mypy strict and the unit tests
with a coverage gate: it fails below `COV_MIN` line coverage (99; a ratchet,
raise it, never lower it). Integration-marked tests are excluded.

## License

MIT.

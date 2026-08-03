# Cross-Language Consumption — Plan 1: Foundation + Redis

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class consume side (`@on_event` / `@OnEvent` + `ConsumerRegistry` + `InMemoryConsumer` + `RedisStreamConsumer`) in both Python and Node, plus the opt-in service-prefix contract change, proven by a Node↔Python Redis interop round-trip.

**Architecture:** The consume side mirrors the existing produce side (adapter → registry → decorator). A `ConsumerAdapter` drains one pipe at-least-once with backend-native acks; a `ConsumerRegistry` holds named consumers with explicit `start()`/`stop()`; `@on_event(event_name, consumer=?)` dispatches validated `(payload, metadata)` to handlers by `eventName`. The opt-in `SERVER_DECORATOR_SERVICE` config adds a `${service}.` prefix to auto-topics and stamps `metadata.service` (minor contract bump 1.0.0 → 1.1.0).

**Tech Stack:** TypeScript (stage-2 decorators, Jest, ts-jest, ioredis), Python 3.10+ (asyncio, pytest-asyncio, mypy strict, ruff, redis.asyncio), JSON Schema (ajv), Redis Streams consumer groups.

**Spec:** `docs/superpowers/specs/2026-06-17-cross-language-consumption-design.md`

**Scope note:** This is Plan 1 of 2. Plan 2 adds Kafka, BullMQ, and RabbitMQ consumers + their interop scenarios. Plan 1 alone ships the headline feature (cross-language consumption over Redis Streams) and the entire contract + decorator + registry foundation that Plan 2 reuses.

---

## File Structure

**Contracts (changed together — one version bump):**
- `contracts/VERSION` — `1.0.0` → `1.1.0`
- `contracts/CHANGELOG.md` — add `## [1.1.0]` entry
- `contracts/rules/topic-naming.md` — document optional 3-segment service-prefixed auto-topic
- `contracts/schemas/queue-message.schema.json` — add optional `metadata.service`
- `contracts/fixtures/queue-message.valid-with-service.json` — new valid fixture
- `node/src/_contract.ts` — `1.0.0` → `1.1.0`
- `python/src/server_decorator/_contract.py` — `1.0.0` → `1.1.0`

**Python — produce-side service config:**
- `python/src/server_decorator/config.py` — NEW: `configure(service=...)`, `get_service()` reading `SERVER_DECORATOR_SERVICE`
- `python/src/server_decorator/decorators/emit_on_success.py` — apply prefix + stamp `metadata.service`

**Python — consume side (new `consumer/` package):**
- `python/src/server_decorator/consumer/__init__.py`
- `python/src/server_decorator/consumer/adapter.py` — `ConsumerAdapter` Protocol, `Handler` type
- `python/src/server_decorator/consumer/validate.py` — envelope validation helper
- `python/src/server_decorator/consumer/inmemory.py` — `InMemoryConsumer`
- `python/src/server_decorator/consumer/registry.py` — `ConsumerRegistry`, `global_consumer_registry`
- `python/src/server_decorator/consumer/adapters/redis_consumer.py` — `RedisStreamConsumer`
- `python/src/server_decorator/decorators/on_event.py` — `@on_event`
- `python/src/server_decorator/__init__.py` — barrel exports

**Node — produce-side service config:**
- `node/src/config.ts` — NEW: `configure({ service })`, `getService()` reading `SERVER_DECORATOR_SERVICE`
- `node/src/decorators/emit-on-success.ts` — apply prefix + stamp `metadata.service`

**Node — consume side:**
- `node/src/decorators/consumer-registry.ts` — `ConsumerAdapter`, `ConsumerRegistry`, `globalConsumerRegistry`, `InMemoryConsumer`
- `node/src/decorators/consumer-adapters.ts` — `RedisStreamConsumer`
- `node/src/decorators/on-event.ts` — `@OnEvent`
- `node/src/index.ts` — barrel exports

**Interop:**
- `interop/scenarios/node-emit-python-consume/{producer.ts,consumer.py,run.sh}` — uses `@on_event`
- `interop/scenarios/python-emit-node-consume/{producer.py,consumer.ts,run.sh}` — uses `@OnEvent`

**Docs:**
- `docs/adr/` — new ADR for the consume side + service prefix
- `node/README.md`, `python/README.md` — consume usage + idempotency caveat

---

## Task 1: Contract change — service prefix (1.0.0 → 1.1.0)

**Files:**
- Modify: `contracts/rules/topic-naming.md`
- Modify: `contracts/schemas/queue-message.schema.json`
- Create: `contracts/fixtures/queue-message.valid-with-service.json`
- Modify: `contracts/CHANGELOG.md`
- Modify: `contracts/VERSION`
- Modify: `node/src/_contract.ts`
- Modify: `python/src/server_decorator/_contract.py`

- [ ] **Step 1: Add the new valid fixture**

Create `contracts/fixtures/queue-message.valid-with-service.json`:

```json
{
  "eventName": "UserService.create",
  "payload": {
    "userId": "u-1",
    "email": "a@example.com"
  },
  "timestamp": 1746748800000,
  "metadata": {
    "className": "UserService",
    "methodName": "create",
    "topic": "user-svc.UserService.create",
    "service": "user-svc"
  }
}
```

- [ ] **Step 2: Add `service` to the schema**

In `contracts/schemas/queue-message.schema.json`, inside `properties.metadata.properties`, add a `service` property after `topic` (keep `additionalProperties: true`):

```json
        "topic": {
          "type": ["string", "null"],
          "description": "Routing topic. May be auto-derived (ClassName.methodName or service.ClassName.methodName) or explicit; null when neither is set."
        },
        "service": {
          "type": "string",
          "description": "Optional logical service name (from SERVER_DECORATOR_SERVICE / configure()). When set, the auto-topic is prefixed with it. Absent when no service is configured."
        }
```

- [ ] **Step 3: Run contract validation — expect PASS**

Run: `bash contracts/scripts/validate.sh`
Expected: `OK   queue-message.valid-with-service.json` and `All contract fixtures validate.` (exit 0). The new fixture validates because `service` is now a known optional string and `metadata` allows additional properties anyway.

- [ ] **Step 4: Document the 3-segment auto-topic form**

In `contracts/rules/topic-naming.md`, replace the `## Auto-generated topic format` section body with:

```markdown
## Auto-generated topic format

When `@EmitOnSuccess` / `@emit_on_success` is used without an explicit `topic` option, the topic is auto-derived.

Without a configured service (default):

```
ClassName.methodName
```

With a service configured via `SERVER_DECORATOR_SERVICE` (env) or `configure(service=...)`:

```
service.ClassName.methodName
```

Both names taken verbatim from runtime introspection (Node: `target.constructor.name` + `propertyKey`; Python: `__qualname__` last two segments). The service segment is taken verbatim from configuration and may contain hyphens (e.g. `user-svc`).
```

Then replace the `## Validation regex (auto form only)` section body with:

```markdown
## Validation regex (auto form only)

Two-segment form (no service configured):

```
^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
```

Three-segment form (service configured); the service segment additionally allows hyphens:

```
^[A-Za-z_][A-Za-z0-9-]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$
```

Matches (2-seg): `OrderService.createOrder`, `UserService.login`, `_PrivateService.helper`
Matches (3-seg): `user-svc.UserService.create`, `quant.OhlcService.createCandle`

Does **not** match either form: `123Service.method` (must start with letter/underscore), `Service.create-order` (Class/method segments forbid hyphens).
```

- [ ] **Step 5: Add the CHANGELOG entry**

In `contracts/CHANGELOG.md`, insert directly under the top `# Contract Changelog` intro paragraph (above `## [1.0.0]`):

```markdown
## [1.1.0] — 2026-06-17

### Added

- `metadata.service` (optional string) on `schemas/queue-message.schema.json`. Stamped by producers when a service name is configured via `SERVER_DECORATOR_SERVICE` / `configure(service=...)`. Backward compatible: absent when no service is configured; consumers that ignore it are unaffected.
- `rules/topic-naming.md` — optional 3-segment auto-topic form `service.ClassName.methodName`, used only when a service is configured. The 2-segment form remains the default.
- `fixtures/queue-message.valid-with-service.json` — golden example of a service-prefixed envelope.

This is an additive, opt-in minor bump. No existing message changes shape unless a service name is configured. The cache-key algorithm is untouched (no cache flush required).
```

- [ ] **Step 6: Bump the three version markers**

Set `contracts/VERSION` to exactly:

```
1.1.0
```

In `node/src/_contract.ts` change the constant:

```typescript
export const CONTRACT_VERSION = '1.1.0' as const
```

In `python/src/server_decorator/_contract.py` change the constant:

```python
CONTRACT_VERSION = "1.1.0"
```

- [ ] **Step 7: Verify validation + version-match logic**

Run: `bash contracts/scripts/validate.sh`
Expected: exit 0, `All contract fixtures validate.`

Run the same assertion CI uses (from `.github/workflows/ci-contracts.yml`):
```bash
contract=$(cat contracts/VERSION | tr -d '[:space:]')
py_v=$(grep -oE 'CONTRACT_VERSION[[:space:]]*=[[:space:]]*"[^"]+"' python/src/server_decorator/_contract.py | grep -oE '"[^"]+"' | tr -d '"')
node_v=$(grep -oE "CONTRACT_VERSION[[:space:]]*=[[:space:]]*'[^']+'" node/src/_contract.ts | grep -oE "'[^']+'" | tr -d "'")
echo "contract=$contract node=$node_v python=$py_v"
[ "$contract" = "$py_v" ] && [ "$contract" = "$node_v" ] && echo "MATCH"
```
Expected: `contract=1.1.0 node=1.1.0 python=1.1.0` then `MATCH`.

- [ ] **Step 8: Commit**

```bash
git add contracts/ node/src/_contract.ts python/src/server_decorator/_contract.py
git commit -m "feat(contracts): add optional metadata.service + 3-segment auto-topic (1.1.0)"
```

---

## Task 2: Python produce-side service config

**Files:**
- Create: `python/src/server_decorator/config.py`
- Test: `python/tests/unit/test_config.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_config.py`:

```python
import importlib

import server_decorator.config as cfg


def setup_function() -> None:
    cfg.configure(service=None)


def test_default_service_is_none(monkeypatch) -> None:
    monkeypatch.delenv("SERVER_DECORATOR_SERVICE", raising=False)
    importlib.reload(cfg)
    assert cfg.get_service() is None


def test_env_var_sets_service(monkeypatch) -> None:
    monkeypatch.setenv("SERVER_DECORATOR_SERVICE", "user-svc")
    importlib.reload(cfg)
    assert cfg.get_service() == "user-svc"


def test_configure_overrides_env(monkeypatch) -> None:
    monkeypatch.setenv("SERVER_DECORATOR_SERVICE", "from-env")
    importlib.reload(cfg)
    cfg.configure(service="from-code")
    assert cfg.get_service() == "from-code"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/unit/test_config.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'server_decorator.config'`.

- [ ] **Step 3: Write minimal implementation**

Create `python/src/server_decorator/config.py`:

```python
"""Library-level configuration. Currently just the optional service name used to
prefix auto-topics and stamp ``metadata.service`` (contract 1.1.0)."""

from __future__ import annotations

import os

_service: str | None = os.environ.get("SERVER_DECORATOR_SERVICE") or None


def configure(*, service: str | None) -> None:
    """Set (or clear) the logical service name. Overrides SERVER_DECORATOR_SERVICE."""
    global _service
    _service = service or None


def get_service() -> str | None:
    """Return the configured service name, or None when unset."""
    return _service
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/unit/test_config.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add python/src/server_decorator/config.py python/tests/unit/test_config.py
git commit -m "feat(python): add configure()/get_service() service config"
```

---

## Task 3: Python — apply service prefix in emit_on_success

**Files:**
- Modify: `python/src/server_decorator/decorators/emit_on_success.py`
- Test: `python/tests/unit/test_emit_service_prefix.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_emit_service_prefix.py`:

```python
import pytest

import server_decorator.config as cfg
from server_decorator import (
    InMemoryQueueAdapter,
    emit_on_success,
    global_queue_registry,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    global_queue_registry.clear()
    cfg.configure(service=None)
    yield
    cfg.configure(service=None)


async def test_no_service_keeps_two_segment_topic() -> None:
    a = InMemoryQueueAdapter()
    global_queue_registry.register("q", a)

    class OrderService:
        @emit_on_success(use_queue=True, queue="q")
        async def create_order(self, x: int) -> int:
            return x

    await OrderService().create_order(1)
    msg = a.messages["OrderService.create_order"][0]
    assert msg["metadata"]["topic"] == "OrderService.create_order"
    assert "service" not in msg["metadata"]


async def test_service_prefixes_topic_and_stamps_metadata() -> None:
    cfg.configure(service="user-svc")
    a = InMemoryQueueAdapter()
    global_queue_registry.register("q", a)

    class UserService:
        @emit_on_success(use_queue=True, queue="q")
        async def create(self, x: int) -> int:
            return x

    await UserService().create(1)
    msg = a.messages["user-svc.UserService.create"][0]
    assert msg["metadata"]["topic"] == "user-svc.UserService.create"
    assert msg["metadata"]["service"] == "user-svc"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/unit/test_emit_service_prefix.py -q`
Expected: FAIL — `KeyError: 'user-svc.UserService.create'` (the prefix isn't applied yet; message lands under the 2-segment topic).

- [ ] **Step 3: Write minimal implementation**

In `python/src/server_decorator/decorators/emit_on_success.py`, add the import near the top (with the other relative imports):

```python
from ..config import get_service
```

Locate the `_on_success` inner helper where it computes `resolved_event` / builds the `msg` dict and calls `global_queue_registry.publish(...)`. Replace the auto-topic derivation and publish so the service prefix is applied. The existing code resolves the event name from the shortened qualname and publishes with an auto-topic of `resolved_event`. Change it to:

```python
        service = get_service()
        auto_topic = resolved_event
        if service and opts.topic is None:
            auto_topic = f"{service}.{resolved_event}"

        msg: QueueMessage = {
            "eventName": resolved_event,
            "payload": payload,
            "timestamp": int(time.time() * 1000),
            "metadata": {
                "className": class_name,
                "methodName": method_name,
                "topic": opts.topic,
                **({"service": service} if service else {}),
                **opts.queue_metadata,
            },
        }

        if opts.use_queue:
            await global_queue_registry.publish(
                msg,
                opts.queue,
                opts.topic or auto_topic,
            )
```

> Note: `resolved_event` (the `eventName`) stays the bare `ClassName.methodName`; only the **topic** gains the service prefix. This matches the spec: identity vs routing are separate. `metadata.topic` is left as `opts.topic` (possibly None) before publish; the registry overwrites it with the effective topic, exactly as today.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/unit/test_emit_service_prefix.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Run the full produce-side suite to confirm no regression**

Run: `cd python && uv run pytest tests/unit/test_emit_on_success.py -q`
Expected: PASS (all existing tests still green — no service is configured there, so topics stay 2-segment).

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/decorators/emit_on_success.py python/tests/unit/test_emit_service_prefix.py
git commit -m "feat(python): service-prefix auto-topic + stamp metadata.service"
```

---

## Task 4: Python ConsumerAdapter protocol + envelope validation + InMemoryConsumer

**Files:**
- Create: `python/src/server_decorator/consumer/__init__.py`
- Create: `python/src/server_decorator/consumer/adapter.py`
- Create: `python/src/server_decorator/consumer/validate.py`
- Create: `python/src/server_decorator/consumer/inmemory.py`
- Test: `python/tests/unit/test_consumer_validate.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_consumer_validate.py`:

```python
from server_decorator.consumer.validate import InvalidEnvelope, validate_envelope


def test_valid_envelope_returns_payload_and_metadata() -> None:
    raw = {
        "eventName": "UserService.create",
        "payload": {"id": 1},
        "timestamp": 1746748800000,
        "metadata": {"service": "user-svc"},
    }
    event_name, payload, metadata = validate_envelope(raw)
    assert event_name == "UserService.create"
    assert payload == {"id": 1}
    assert metadata == {"service": "user-svc"}


def test_missing_event_name_raises() -> None:
    try:
        validate_envelope({"payload": 1, "timestamp": 0})
    except InvalidEnvelope as e:
        assert "eventName" in str(e)
    else:
        raise AssertionError("expected InvalidEnvelope")


def test_non_dict_raises() -> None:
    try:
        validate_envelope("not-a-dict")
    except InvalidEnvelope:
        pass
    else:
        raise AssertionError("expected InvalidEnvelope")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/unit/test_consumer_validate.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'server_decorator.consumer'`.

- [ ] **Step 3: Write minimal implementation**

Create `python/src/server_decorator/consumer/__init__.py`:

```python
"""Consume side: ConsumerAdapter protocol, registry, decorator, and adapters."""
```

Create `python/src/server_decorator/consumer/validate.py`:

```python
"""Validate an inbound wire envelope and split it into (eventName, payload, metadata).

Kept deliberately light: a structural check matching contracts/schemas/queue-message
(required eventName:str, payload present, timestamp:int). Full JSON-Schema validation is
done in parity/interop tests; the runtime path stays dependency-free."""

from __future__ import annotations

from typing import Any


class InvalidEnvelope(ValueError):
    """Raised when an inbound message does not match the QueueMessage contract."""


def validate_envelope(raw: Any) -> tuple[str, Any, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise InvalidEnvelope(f"envelope must be an object, got {type(raw).__name__}")
    event_name = raw.get("eventName")
    if not isinstance(event_name, str) or not event_name:
        raise InvalidEnvelope("envelope missing required non-empty string 'eventName'")
    if "payload" not in raw:
        raise InvalidEnvelope("envelope missing required 'payload'")
    timestamp = raw.get("timestamp")
    if not isinstance(timestamp, int):
        raise InvalidEnvelope("envelope missing required integer 'timestamp'")
    metadata = raw.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise InvalidEnvelope("envelope 'metadata' must be an object when present")
    return event_name, raw["payload"], metadata
```

Create `python/src/server_decorator/consumer/adapter.py`:

```python
"""ConsumerAdapter protocol — the consume-side dual of QueueAdapter.

An adapter drains exactly one pipe at-least-once. It receives raw frames, hands each
decoded JSON value to ``dispatch``, and acks ONLY when dispatch returns without raising.
When dispatch raises, the adapter must NOT ack (backend-native redelivery)."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Protocol

# dispatch(raw_json_value) -> awaitable; raising means "do not ack".
Dispatch = Callable[[Any], Awaitable[None]]


class ConsumerAdapter(Protocol):
    async def run(self, dispatch: Dispatch) -> None:
        """Begin consuming, calling dispatch per message, until stop() is called."""//
        ...

    async def stop(self) -> None:
        """Stop consuming and release resources."""
        ...
```

> **Fix while typing:** delete the stray `//` at the end of the `run` docstring line above — it is not valid Python. The line must read exactly `        """Begin consuming, calling dispatch per message, until stop() is called."""`.

Create `python/src/server_decorator/consumer/inmemory.py`:

```python
"""In-memory consumer for unit tests — the dual of InMemoryQueueAdapter. Feed it raw
envelopes via ``feed`` (or construct with a list); ``run`` dispatches each one."""

from __future__ import annotations

import asyncio
from typing import Any

from .adapter import Dispatch


class InMemoryConsumer:
    def __init__(self, messages: list[Any] | None = None) -> None:
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._stop = asyncio.Event()
        for m in messages or []:
            self._queue.put_nowait(m)

    def feed(self, raw: Any) -> None:
        self._queue.put_nowait(raw)

    async def run(self, dispatch: Dispatch) -> None:
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(self._queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            await dispatch(raw)

    async def stop(self) -> None:
        self._stop.set()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/unit/test_consumer_validate.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Type-check the new module**

Run: `cd python && uv run mypy src/server_decorator/consumer`
Expected: `Success: no issues found`.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/
git add python/tests/unit/test_consumer_validate.py
git commit -m "feat(python): consumer adapter protocol, envelope validation, InMemoryConsumer"
```

---

## Task 5: Python ConsumerRegistry + dispatch

**Files:**
- Create: `python/src/server_decorator/consumer/registry.py`
- Test: `python/tests/unit/test_consumer_registry.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_consumer_registry.py`:

```python
import asyncio

import pytest

from server_decorator.consumer.inmemory import InMemoryConsumer
from server_decorator.consumer.registry import ConsumerRegistry


def _envelope(event_name: str, payload: object) -> dict:
    return {
        "eventName": event_name,
        "payload": payload,
        "timestamp": 1,
        "metadata": {"service": "svc"},
    }


async def test_dispatches_to_matching_handler() -> None:
    got: list[tuple] = []
    consumer = InMemoryConsumer([_envelope("A.x", {"n": 1})])
    reg = ConsumerRegistry()
    reg.register("c", consumer)
    reg.on("A.x", lambda p, m: got.append((p, m)), consumer="c")

    await reg.start()
    await asyncio.sleep(0.1)
    await reg.stop()

    assert got == [({"n": 1}, {"service": "svc"})]


async def test_unmatched_is_acked_and_skipped() -> None:
    unhandled: list[str] = []
    consumer = InMemoryConsumer([_envelope("B.y", 1)])
    reg = ConsumerRegistry()
    reg.register("c", consumer, on_unhandled=lambda ev, raw: unhandled.append(ev))
    reg.on("A.x", lambda p, m: None, consumer="c")

    await reg.start()
    await asyncio.sleep(0.1)
    await reg.stop()

    assert unhandled == ["B.y"]


async def test_invalid_envelope_routed_to_on_invalid() -> None:
    invalid: list[object] = []
    consumer = InMemoryConsumer(["not-a-dict"])
    reg = ConsumerRegistry()
    reg.register("c", consumer, on_invalid=lambda raw, err: invalid.append(raw))
    reg.on("A.x", lambda p, m: None, consumer="c")

    await reg.start()
    await asyncio.sleep(0.1)
    await reg.stop()

    assert invalid == ["not-a-dict"]


async def test_handler_raise_propagates_to_adapter() -> None:
    # When a handler raises, dispatch must raise so the adapter does NOT ack.
    consumer = InMemoryConsumer([_envelope("A.x", 1)])
    reg = ConsumerRegistry()
    reg.register("c", consumer)

    def boom(p: object, m: object) -> None:
        raise RuntimeError("handler failed")

    reg.on("A.x", boom, consumer="c")
    with pytest.raises(RuntimeError, match="handler failed"):
        await reg._dispatch_for("c")(_envelope("A.x", 1))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/unit/test_consumer_registry.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'server_decorator.consumer.registry'`.

- [ ] **Step 3: Write minimal implementation**

Create `python/src/server_decorator/consumer/registry.py`:

```python
"""ConsumerRegistry — the consume-side dual of QueueRegistry. Holds named consumers,
routes inbound messages to handlers by eventName, and owns the start/stop lifecycle.

Delivery contract: a handler that returns normally => the message is acked by the
adapter. A handler that raises => dispatch re-raises => the adapter does not ack =>
backend-native redelivery (at-least-once). Handlers MUST be idempotent."""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .adapter import ConsumerAdapter, Dispatch
from .validate import InvalidEnvelope, validate_envelope

_log = logging.getLogger("server_decorator.consumer")

Handler = Callable[[Any, dict[str, Any]], Any]  # (payload, metadata) -> None | Awaitable
UnhandledHook = Callable[[str, Any], None]
InvalidHook = Callable[[Any, Exception], None]


@dataclass
class _ConsumerEntry:
    adapter: ConsumerAdapter
    handlers: dict[str, Handler] = field(default_factory=dict)
    on_unhandled: UnhandledHook | None = None
    on_invalid: InvalidHook | None = None


class ConsumerRegistry:
    def __init__(self) -> None:
        self._consumers: dict[str, _ConsumerEntry] = {}
        self._default: str | None = None
        self._tasks: list[asyncio.Task[None]] = []

    def register(
        self,
        name: str,
        adapter: ConsumerAdapter,
        *,
        on_unhandled: UnhandledHook | None = None,
        on_invalid: InvalidHook | None = None,
    ) -> None:
        self._consumers[name] = _ConsumerEntry(
            adapter=adapter, on_unhandled=on_unhandled, on_invalid=on_invalid
        )
        if self._default is None:
            self._default = name

    def set_default(self, name: str) -> None:
        if name not in self._consumers:
            raise KeyError(name)
        self._default = name

    def on(self, event_name: str, handler: Handler, *, consumer: str | None = None) -> None:
        entry = self._entry(consumer)
        entry.handlers[event_name] = handler

    def clear(self) -> None:
        self._consumers.clear()
        self._default = None
        self._tasks.clear()

    async def start(self) -> None:
        for name, entry in self._consumers.items():
            dispatch = self._dispatch_for(name)
            self._tasks.append(asyncio.create_task(entry.adapter.run(dispatch)))

    async def stop(self) -> None:
        for entry in self._consumers.values():
            await entry.adapter.stop()
        for task in self._tasks:
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
        self._tasks.clear()

    def _entry(self, consumer: str | None) -> _ConsumerEntry:
        name = consumer or self._default
        if name is None or name not in self._consumers:
            raise KeyError(f"consumer {consumer!r} not registered")
        return self._consumers[name]

    def _dispatch_for(self, name: str) -> Dispatch:
        entry = self._consumers[name]

        async def dispatch(raw: Any) -> None:
            try:
                event_name, payload, metadata = validate_envelope(raw)
            except InvalidEnvelope as err:
                if entry.on_invalid:
                    entry.on_invalid(raw, err)
                else:
                    _log.warning("invalid envelope dropped: %s", err)
                return  # acked + skipped
            handler = entry.handlers.get(event_name)
            if handler is None:
                if entry.on_unhandled:
                    entry.on_unhandled(event_name, raw)
                else:
                    _log.debug("no handler for event %s; acked + skipped", event_name)
                return  # acked + skipped
            result = handler(payload, metadata)
            if inspect.isawaitable(result):
                await result  # a raise here propagates → adapter does not ack

        return dispatch


global_consumer_registry = ConsumerRegistry()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/unit/test_consumer_registry.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Type-check**

Run: `cd python && uv run mypy src/server_decorator/consumer`
Expected: `Success: no issues found`.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/registry.py python/tests/unit/test_consumer_registry.py
git commit -m "feat(python): ConsumerRegistry with eventName dispatch + unhandled/invalid hooks"
```

---

## Task 6: Python `@on_event` decorator

**Files:**
- Create: `python/src/server_decorator/decorators/on_event.py`
- Modify: `python/src/server_decorator/__init__.py`
- Test: `python/tests/unit/test_on_event.py`

- [ ] **Step 1: Write the failing test**

Create `python/tests/unit/test_on_event.py`:

```python
import asyncio

import pytest

from server_decorator import (
    ConsumerRegistry,
    InMemoryConsumer,
    on_event,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    from server_decorator import global_consumer_registry

    global_consumer_registry.clear()
    yield
    global_consumer_registry.clear()


async def test_on_event_registers_async_handler() -> None:
    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([
        {"eventName": "A.x", "payload": {"n": 1}, "timestamp": 1, "metadata": {}},
    ]))

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    await reg.start()
    await asyncio.sleep(0.1)
    await reg.stop()

    assert got == [{"n": 1}]


async def test_on_event_uses_global_registry_by_default() -> None:
    from server_decorator import global_consumer_registry

    got: list = []
    global_consumer_registry.register("c", InMemoryConsumer([
        {"eventName": "A.x", "payload": 7, "timestamp": 1, "metadata": {}},
    ]))

    @on_event("A.x", consumer="c")
    async def handle(payload, meta):
        got.append(payload)

    await global_consumer_registry.start()
    await asyncio.sleep(0.1)
    await global_consumer_registry.stop()

    assert got == [7]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd python && uv run pytest tests/unit/test_on_event.py -q`
Expected: FAIL — `ImportError: cannot import name 'on_event' from 'server_decorator'`.

- [ ] **Step 3: Write minimal implementation**

Create `python/src/server_decorator/decorators/on_event.py`:

```python
"""@on_event — register a function as a handler for an inbound event.

The decorated function is registered into a ConsumerRegistry (the global one by
default) keyed by event_name on the named consumer. It is returned unchanged, so it
remains directly callable/testable. Handlers receive (payload, metadata)."""

from __future__ import annotations

from typing import Any, Callable

from ..consumer.registry import ConsumerRegistry, Handler, global_consumer_registry


def on_event(
    event_name: str,
    *,
    consumer: str | None = None,
    registry: ConsumerRegistry | None = None,
) -> Callable[[Handler], Handler]:
    target = registry or global_consumer_registry

    def decorate(fn: Handler) -> Handler:
        target.on(event_name, fn, consumer=consumer)
        return fn

    return decorate
```

In `python/src/server_decorator/__init__.py`, add imports and extend `__all__`. Add these imports alongside the existing ones:

```python
from .config import configure, get_service
from .consumer.inmemory import InMemoryConsumer
from .consumer.registry import ConsumerRegistry, global_consumer_registry
from .decorators.on_event import on_event
```

And add these names to the `__all__` list:

```python
    "configure",
    "get_service",
    "on_event",
    "ConsumerRegistry",
    "global_consumer_registry",
    "InMemoryConsumer",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest tests/unit/test_on_event.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Full unit suite + lint + types**

Run: `cd python && bash scripts/check.sh`
Expected: ruff clean, ruff format clean, mypy `Success`, pytest all passed.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/decorators/on_event.py python/src/server_decorator/__init__.py python/tests/unit/test_on_event.py
git commit -m "feat(python): @on_event decorator + barrel exports"
```

---

## Task 7: Python RedisStreamConsumer (groups + XACK)

**Files:**
- Create: `python/src/server_decorator/consumer/adapters/__init__.py`
- Create: `python/src/server_decorator/consumer/adapters/redis_consumer.py`
- Test: `python/tests/integration/test_redis_consumer.py`

- [ ] **Step 1: Write the failing integration test**

Create `python/tests/integration/test_redis_consumer.py`:

```python
import asyncio
import json

import pytest

redis_asyncio = pytest.importorskip("redis.asyncio")

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.redis_consumer import RedisStreamConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_acks(redis_url: str) -> None:
    client = redis_asyncio.from_url(redis_url)
    stream = "test-consume-stream"
    group = "test-group"
    await client.delete(stream)

    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=stream, group=group, consumer_name="w1"))

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    # Produce two messages directly.
    for n in (1, 2):
        msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
        await client.xadd(stream, {"data": json.dumps(msg)})

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 5
    while len(got) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)
    await reg.stop()

    assert got == [{"n": 1}, {"n": 2}]
    # All acked: pending entries list is empty.
    pending = await client.xpending(stream, group)
    assert pending["pending"] == 0
    await client.aclose()
```

Add a `redis_url` fixture to `python/tests/integration/conftest.py` (create the file if absent):

```python
import os

import pytest


@pytest.fixture
def redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379")
```

- [ ] **Step 2: Run test to verify it fails**

Start Redis first: `docker compose -f interop/docker-compose.yml up -d redis`
Run: `cd python && uv run pytest -m integration tests/integration/test_redis_consumer.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'server_decorator.consumer.adapters.redis_consumer'`.

- [ ] **Step 3: Write minimal implementation**

Create `python/src/server_decorator/consumer/adapters/__init__.py`:

```python
"""Concrete consumer adapters (Redis Streams, etc.)."""
```

Create `python/src/server_decorator/consumer/adapters/redis_consumer.py`:

```python
"""RedisStreamConsumer — at-least-once consume over a Redis stream using a consumer
group. Reads with XREADGROUP, dispatches the JSON in the ``data`` field (matching the
producer's RedisStreamAdapter), and XACKs only on successful dispatch. A handler that
raises leaves the entry pending → reclaimable (at-least-once)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ..adapter import Dispatch


class RedisStreamConsumer:
    def __init__(
        self,
        client: Any,
        *,
        stream: str = "default",
        group: str = "server-decorator",
        consumer_name: str = "consumer-1",
        block_ms: int = 1000,
        batch: int = 10,
    ) -> None:
        self._client = client
        self._stream = stream
        self._group = group
        self._name = consumer_name
        self._block_ms = block_ms
        self._batch = batch
        self._stop = asyncio.Event()

    async def _ensure_group(self) -> None:
        try:
            await self._client.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except Exception as err:  # noqa: BLE001 - redis raises a BUSYGROUP error string
            if "BUSYGROUP" not in str(err):
                raise

    async def run(self, dispatch: Dispatch) -> None:
        await self._ensure_group()
        while not self._stop.is_set():
            resp = await self._client.xreadgroup(
                self._group,
                self._name,
                {self._stream: ">"},
                count=self._batch,
                block=self._block_ms,
            )
            if not resp:
                continue
            for _stream_key, entries in resp:
                for entry_id, fields in entries:
                    data = fields.get(b"data") or fields.get("data")
                    raw = json.loads(data)
                    await dispatch(raw)  # raise here → skip XACK (stays pending)
                    await self._client.xack(self._stream, self._group, entry_id)

    async def stop(self) -> None:
        self._stop.set()
```

Add `redis` to the mypy override modules if not already present (it is, per `pyproject.toml`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd python && uv run pytest -m integration tests/integration/test_redis_consumer.py -q`
Expected: PASS (1 passed). Stop Redis after: `docker compose -f interop/docker-compose.yml down -v`.

- [ ] **Step 5: Lint + type-check**

Run: `cd python && uv run ruff check src && uv run mypy src/server_decorator/consumer`
Expected: ruff clean, mypy `Success`.

- [ ] **Step 6: Commit**

```bash
git add python/src/server_decorator/consumer/adapters/ python/tests/integration/test_redis_consumer.py python/tests/integration/conftest.py
git commit -m "feat(python): RedisStreamConsumer (groups + XACK), integration test"
```

---

## Task 8: Node ConsumerAdapter + InMemoryConsumer + ConsumerRegistry

**Files:**
- Create: `node/src/decorators/consumer-registry.ts`
- Test: `node/src/decorators/consumer-registry.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `node/src/decorators/consumer-registry.spec.ts`:

```typescript
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'

function env(eventName: string, payload: unknown) {
  return { eventName, payload, timestamp: 1, metadata: { service: 'svc' } }
}

describe('ConsumerRegistry', () => {
  it('dispatches to the matching handler by eventName', async () => {
    const got: Array<[unknown, unknown]> = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('A.x', { n: 1 })]))
    reg.on('A.x', (p, m) => { got.push([p, m]) }, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toEqual([[{ n: 1 }, { service: 'svc' }]])
  })

  it('acks + skips unmatched events via on_unhandled', async () => {
    const unhandled: string[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('B.y', 1)]), {
      onUnhandled: (ev) => { unhandled.push(ev) },
    })
    reg.on('A.x', () => {}, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(unhandled).toEqual(['B.y'])
  })

  it('routes invalid envelopes to onInvalid', async () => {
    const invalid: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer(['not-an-object']), {
      onInvalid: (raw) => { invalid.push(raw) },
    })
    reg.on('A.x', () => {}, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(invalid).toEqual(['not-an-object'])
  })

  it('re-raises when a handler throws (so the adapter does not ack)', async () => {
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([]))
    reg.on('A.x', () => { throw new Error('boom') }, { consumer: 'c' })
    const dispatch = reg.dispatchFor('c')
    await expect(dispatch(env('A.x', 1))).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd node && pnpm test -- --testPathPattern=consumer-registry`
Expected: FAIL — `Cannot find module './consumer-registry'`.

- [ ] **Step 3: Write minimal implementation**

Create `node/src/decorators/consumer-registry.ts`:

```typescript
import { globalLogger } from '../logger'

// dispatch(rawJsonValue) -> Promise; rejecting means "do not ack".
export type Dispatch = (raw: unknown) => Promise<void>

export interface ConsumerAdapter {
  // Begin consuming, calling dispatch per message, until stop() resolves.
  run(dispatch: Dispatch): Promise<void>
  stop(): Promise<void>
}

export type EventHandler = (payload: any, metadata: Record<string, any>) => void | Promise<void>
export type UnhandledHook = (eventName: string, raw: unknown) => void
export type InvalidHook = (raw: unknown, error: Error) => void

export interface RegisterOptions {
  onUnhandled?: UnhandledHook
  onInvalid?: InvalidHook
}

interface ConsumerEntry {
  adapter: ConsumerAdapter
  handlers: Map<string, EventHandler>
  onUnhandled?: UnhandledHook
  onInvalid?: InvalidHook
}

// Structural envelope validation (mirrors contracts/schemas/queue-message).
class InvalidEnvelope extends Error {}

function validateEnvelope(raw: unknown): {
  eventName: string
  payload: unknown
  metadata: Record<string, any>
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidEnvelope('envelope must be an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.eventName !== 'string' || obj.eventName.length === 0) {
    throw new InvalidEnvelope("envelope missing non-empty string 'eventName'")
  }
  if (!('payload' in obj)) {
    throw new InvalidEnvelope("envelope missing 'payload'")
  }
  if (typeof obj.timestamp !== 'number' || !Number.isInteger(obj.timestamp)) {
    throw new InvalidEnvelope("envelope missing integer 'timestamp'")
  }
  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, any>)
      : {}
  return { eventName: obj.eventName, payload: obj.payload, metadata }
}

export class ConsumerRegistry {
  private consumers: Map<string, ConsumerEntry> = new Map()
  private defaultConsumer?: string
  private tasks: Promise<void>[] = []

  register(name: string, adapter: ConsumerAdapter, options: RegisterOptions = {}): void {
    this.consumers.set(name, {
      adapter,
      handlers: new Map(),
      onUnhandled: options.onUnhandled,
      onInvalid: options.onInvalid,
    })
    if (this.defaultConsumer === undefined) this.defaultConsumer = name
  }

  setDefault(name: string): void {
    if (!this.consumers.has(name)) throw new Error(`consumer '${name}' not registered`)
    this.defaultConsumer = name
  }

  on(eventName: string, handler: EventHandler, options: { consumer?: string } = {}): void {
    this.entry(options.consumer).handlers.set(eventName, handler)
  }

  clear(): void {
    this.consumers.clear()
    this.defaultConsumer = undefined
    this.tasks = []
  }

  async start(): Promise<void> {
    for (const [name, entry] of this.consumers.entries()) {
      this.tasks.push(entry.adapter.run(this.dispatchFor(name)))
    }
  }

  async stop(): Promise<void> {
    for (const entry of this.consumers.values()) await entry.adapter.stop()
    await Promise.allSettled(this.tasks)
    this.tasks = []
  }

  private entry(consumer?: string): ConsumerEntry {
    const name = consumer ?? this.defaultConsumer
    if (name === undefined || !this.consumers.has(name)) {
      throw new Error(`consumer '${consumer}' not registered`)
    }
    return this.consumers.get(name)!
  }

  // Exposed for unit testing the dispatch contract directly.
  dispatchFor(name: string): Dispatch {
    const entry = this.consumers.get(name)!
    return async (raw: unknown): Promise<void> => {
      let parsed
      try {
        parsed = validateEnvelope(raw)
      } catch (err) {
        if (entry.onInvalid) entry.onInvalid(raw, err as Error)
        else globalLogger.warn(`invalid envelope dropped: ${(err as Error).message}`)
        return // acked + skipped
      }
      const handler = entry.handlers.get(parsed.eventName)
      if (!handler) {
        if (entry.onUnhandled) entry.onUnhandled(parsed.eventName, raw)
        else globalLogger.debug(`no handler for event ${parsed.eventName}; acked + skipped`)
        return // acked + skipped
      }
      await handler(parsed.payload, parsed.metadata) // throw → caller does not ack
    }
  }
}

// In-memory consumer for unit tests — the dual of InMemoryQueueAdapter.
export class InMemoryConsumer implements ConsumerAdapter {
  private queue: unknown[]
  private stopped = false

  constructor(messages: unknown[] = []) {
    this.queue = [...messages]
  }

  feed(raw: unknown): void {
    this.queue.push(raw)
  }

  async run(dispatch: Dispatch): Promise<void> {
    while (!this.stopped) {
      const raw = this.queue.shift()
      if (raw === undefined) {
        await new Promise((r) => setTimeout(r, 20))
        continue
      }
      await dispatch(raw)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

export const globalConsumerRegistry = new ConsumerRegistry()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && pnpm test -- --testPathPattern=consumer-registry`
Expected: PASS (4 tests).

- [ ] **Step 5: Build to confirm types**

Run: `cd node && pnpm run build`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add node/src/decorators/consumer-registry.ts node/src/decorators/consumer-registry.spec.ts
git commit -m "feat(node): ConsumerRegistry + InMemoryConsumer + envelope validation"
```

---

## Task 9: Node `@OnEvent` decorator + config + service prefix

**Files:**
- Create: `node/src/config.ts`
- Create: `node/src/decorators/on-event.ts`
- Modify: `node/src/decorators/emit-on-success.ts`
- Modify: `node/src/index.ts`
- Test: `node/src/decorators/on-event.spec.ts`
- Test: `node/src/config.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `node/src/config.spec.ts`:

```typescript
import { configure, getService } from './config'

describe('config', () => {
  afterEach(() => configure({ service: null }))

  it('defaults to null when unset', () => {
    configure({ service: null })
    expect(getService()).toBeNull()
  })

  it('configure() sets the service', () => {
    configure({ service: 'user-svc' })
    expect(getService()).toBe('user-svc')
  })
})
```

Create `node/src/decorators/on-event.spec.ts`:

```typescript
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'
import { OnEvent, registerHandlers } from './on-event'

function env(eventName: string, payload: unknown) {
  return { eventName, payload, timestamp: 1, metadata: {} }
}

describe('@OnEvent', () => {
  it('wires a decorated method into the registry', async () => {
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([env('A.x', { n: 1 })]))
    const got: unknown[] = []

    class Handlers {
      @OnEvent('A.x', { consumer: 'c', registry: reg })
      async onCreate(payload: any) {
        got.push(payload)
      }
    }
    registerHandlers(new Handlers())

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toEqual([{ n: 1 }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd node && pnpm test -- --testPathPattern="config|on-event"`
Expected: FAIL — `Cannot find module './config'` and `'./on-event'`.

- [ ] **Step 3: Write minimal implementation**

Create `node/src/config.ts`:

```typescript
// Library-level configuration: the optional service name used to prefix auto-topics
// and stamp metadata.service (contract 1.1.0).

let service: string | null = process.env.SERVER_DECORATOR_SERVICE || null

export function configure(options: { service: string | null }): void {
  service = options.service || null
}

export function getService(): string | null {
  return service
}
```

Create `node/src/decorators/on-event.ts`:

```typescript
import {
  ConsumerRegistry,
  EventHandler,
  globalConsumerRegistry,
} from './consumer-registry'

interface OnEventOptions {
  consumer?: string
  registry?: ConsumerRegistry
}

interface PendingHandler {
  eventName: string
  propertyKey: string
  options: OnEventOptions
}

const PENDING = Symbol('server-decorator.onEvent.pending')

// @OnEvent records the binding on the prototype; registerHandlers(instance) wires the
// bound methods into the registry. Handlers are opt-in by decoration (no class walk).
export function OnEvent(eventName: string, options: OnEventOptions = {}) {
  return function (target: any, propertyKey: string, _descriptor: PropertyDescriptor): void {
    const list: PendingHandler[] = target[PENDING] || (target[PENDING] = [])
    list.push({ eventName, propertyKey, options })
  }
}

export function registerHandlers(instance: any): void {
  const proto = Object.getPrototypeOf(instance)
  const list: PendingHandler[] = proto[PENDING] || []
  for (const { eventName, propertyKey, options } of list) {
    const registry = options.registry ?? globalConsumerRegistry
    const handler: EventHandler = (payload, metadata) =>
      instance[propertyKey](payload, metadata)
    registry.on(eventName, handler, { consumer: options.consumer })
  }
}
```

In `node/src/decorators/emit-on-success.ts`: add the import at the top:

```typescript
import { getService } from '../config'
```

Then in `handleSuccess`, where it builds the `message` and computes `autoTopic`, apply the prefix and stamp `service`. Replace the queue-publishing block's message construction and `autoTopic` line so it reads:

```typescript
  // Queue publishing
  if (useQueue) {
    try {
      const service = getService()
      const message: QueueMessage = {
        eventName,
        payload,
        timestamp: Date.now(),
        metadata: {
          className,
          methodName: propertyKey,
          topic,
          ...(service ? { service } : {}),
          ...queueMetadata
        }
      };

      if (queueName || topic) {
        const base = `${className}.${propertyKey}`;
        const autoTopic = topic || (service ? `${service}.${base}` : base);
        await globalQueueRegistry.publish(message, queueName, autoTopic);
      } else {
        if (globalQueue) {
          await globalQueue.publish(message);
        } else {
          await globalQueueRegistry.publish(message);
        }
      }

      globalLogger.debug(`📮 Message queued: ${eventName} -> ${queueName || 'default'}`);
    } catch (error) {
      globalLogger.error(`Failed to publish to queue: ${error}`);
    }
  }
```

In `node/src/index.ts`, add exports after the existing decorator exports:

```typescript
// Config
export { configure, getService } from './config';

// Consumer system
export {
  ConsumerRegistry,
  InMemoryConsumer,
  globalConsumerRegistry,
  type ConsumerAdapter,
  type EventHandler,
} from './decorators/consumer-registry';
export { OnEvent, registerHandlers } from './decorators/on-event';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd node && pnpm test -- --testPathPattern="config|on-event"`
Expected: PASS (config 2, on-event 1).

- [ ] **Step 5: Add a Node service-prefix test for emit, then run unit suite**

Create `node/src/decorators/emit-service-prefix.spec.ts`:

```typescript
import { configure } from '../config'
import { EmitOnSuccess } from './emit-on-success'
import { InMemoryQueueAdapter } from './queue-adapters'
import { globalQueueRegistry } from './queue-registry'

describe('EmitOnSuccess service prefix', () => {
  afterEach(() => {
    configure({ service: null })
    globalQueueRegistry.clear()
  })

  it('prefixes the auto-topic and stamps metadata.service when configured', async () => {
    configure({ service: 'user-svc' })
    const adapter = new InMemoryQueueAdapter()
    globalQueueRegistry.register('q', { adapter })

    class UserService {
      @EmitOnSuccess({ useQueue: true, queue: 'q' })
      async create(x: number) {
        return x
      }
    }
    await new UserService().create(1)

    const msgs = adapter.getMessages('user-svc.UserService.create')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata!.topic).toBe('user-svc.UserService.create')
    expect(msgs[0].metadata!.service).toBe('user-svc')
  })
})
```

Run: `cd node && pnpm test:unit`
Expected: PASS — all unit tests, including the new prefix test and the existing emit-on-success snapshots (unchanged because no service is configured in those).

- [ ] **Step 6: Build + commit**

Run: `cd node && pnpm run build` — expect exit 0.

```bash
git add node/src/config.ts node/src/config.spec.ts node/src/decorators/on-event.ts node/src/decorators/on-event.spec.ts node/src/decorators/emit-on-success.ts node/src/decorators/emit-service-prefix.spec.ts node/src/index.ts
git commit -m "feat(node): @OnEvent decorator, config, service-prefix auto-topic"
```

---

## Task 10: Node RedisStreamConsumer

**Files:**
- Create: `node/src/decorators/consumer-adapters.ts`
- Modify: `node/src/index.ts`
- Test: `node/src/integration/redis-consumer.e2e.spec.ts`

- [ ] **Step 1: Write the failing integration test**

Create `node/src/integration/redis-consumer.e2e.spec.ts`:

```typescript
import Redis from 'ioredis'
import { ConsumerRegistry } from '../decorators/consumer-registry'
import { RedisStreamConsumer } from '../decorators/consumer-adapters'

describe('RedisStreamConsumer (e2e)', () => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const stream = 'test-node-consume-stream'
  const group = 'test-group'

  it('consumes messages and XACKs them', async () => {
    const client = new Redis(url)
    await client.del(stream)

    const got: unknown[] = []
    const reg = new ConsumerRegistry()
    reg.register(
      'c',
      new RedisStreamConsumer(client, { stream, group, consumerName: 'w1' }),
    )
    reg.on('A.x', (p) => { got.push(p) }, { consumer: 'c' })

    for (const n of [1, 2]) {
      const msg = { eventName: 'A.x', payload: { n }, timestamp: 1, metadata: {} }
      await client.xadd(stream, '*', 'data', JSON.stringify(msg))
    }

    await reg.start()
    const deadline = Date.now() + 5000
    while (got.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await reg.stop()

    expect(got).toEqual([{ n: 1 }, { n: 2 }])
    const pending = (await client.xpending(stream, group)) as any[]
    expect(pending[0]).toBe(0) // 0 pending = all acked
    await client.quit()
  }, 30000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Start Redis: `docker compose -f interop/docker-compose.yml up -d redis`
Run: `cd node && pnpm test:e2e -- --testPathPattern=redis-consumer`
Expected: FAIL — `Cannot find module '../decorators/consumer-adapters'`.

- [ ] **Step 3: Write minimal implementation**

Create `node/src/decorators/consumer-adapters.ts`:

```typescript
import type { Redis } from 'ioredis'
import { ConsumerAdapter, Dispatch } from './consumer-registry'

// RedisStreamConsumer — at-least-once consume over a Redis stream via a consumer group.
// Reads with XREADGROUP, dispatches the JSON in the `data` field (matching the
// producer's RedisStreamAdapter), and XACKs only on successful dispatch.
export class RedisStreamConsumer implements ConsumerAdapter {
  private stopped = false

  constructor(
    private client: Redis,
    private options: {
      stream?: string
      group?: string
      consumerName?: string
      blockMs?: number
      batch?: number
    } = {},
  ) {}

  private get stream(): string {
    return this.options.stream ?? 'default'
  }
  private get group(): string {
    return this.options.group ?? 'server-decorator'
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.client.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM')
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err
    }
  }

  async run(dispatch: Dispatch): Promise<void> {
    await this.ensureGroup()
    const consumerName = this.options.consumerName ?? 'consumer-1'
    const blockMs = this.options.blockMs ?? 1000
    const batch = this.options.batch ?? 10
    while (!this.stopped) {
      const resp = (await this.client.xreadgroup(
        'GROUP',
        this.group,
        consumerName,
        'COUNT',
        batch,
        'BLOCK',
        blockMs,
        'STREAMS',
        this.stream,
        '>',
      )) as [string, [string, string[]][]][] | null
      if (!resp) continue
      for (const [, entries] of resp) {
        for (const [entryId, fields] of entries) {
          const idx = fields.indexOf('data')
          const raw = JSON.parse(fields[idx + 1])
          await dispatch(raw) // throw → skip XACK (stays pending)
          await this.client.xack(this.stream, this.group, entryId)
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}
```

In `node/src/index.ts`, add to the consumer exports block:

```typescript
export { RedisStreamConsumer } from './decorators/consumer-adapters';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd node && pnpm test:e2e -- --testPathPattern=redis-consumer`
Expected: PASS (1 test). Stop Redis: `docker compose -f interop/docker-compose.yml down -v`.

- [ ] **Step 5: Build + commit**

Run: `cd node && pnpm run build` — expect exit 0.

```bash
git add node/src/decorators/consumer-adapters.ts node/src/integration/redis-consumer.e2e.spec.ts node/src/index.ts
git commit -m "feat(node): RedisStreamConsumer (groups + XACK), e2e test"
```

---

## Task 11: Interop scenarios (Node↔Python over Redis, via decorators)

**Files:**
- Create: `interop/scenarios/node-emit-python-consume/{producer.ts,consumer.py,run.sh}`
- Create: `interop/scenarios/python-emit-node-consume/{producer.py,consumer.ts,run.sh}`
- Modify: `interop/README.md`

> These mirror the existing `node-producer-python-consumer` scenario but the consumer uses the new `@on_event`/`@OnEvent` + `RedisStreamConsumer` path instead of a raw client read.

- [ ] **Step 1: Write the Node→Python consume scenario**

Create `interop/scenarios/node-emit-python-consume/producer.ts` (same shape as the existing producer, writing the shared fixtures to a stream):

```typescript
// Node producer: writes the shared expected-payloads to a Redis stream as QueueMessage
// JSON (the RedisStreamConsumer on the Python side reads them via @on_event).
import { readFileSync } from 'fs'
import { join } from 'path'
import Redis from 'ioredis'

interface ExpectedPayload {
  eventName: string
  payload: Record<string, unknown>
}

const fixturePath = join(__dirname, '..', '..', 'shared', 'expected-payloads.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { messages: ExpectedPayload[] }
const STREAM = process.env.INTEROP_STREAM ?? 'interop'

async function main(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  for (const expected of fixture.messages) {
    const msg = {
      eventName: expected.eventName,
      payload: expected.payload,
      timestamp: Date.now(),
      metadata: { className: 'OrderService', methodName: 'createOrder', topic: 'orders' },
    }
    await client.xadd(STREAM, '*', 'data', JSON.stringify(msg))
  }
  console.log(`producer: wrote ${fixture.messages.length} messages to stream ${STREAM}`)
  await client.quit()
}

main().catch((err) => {
  console.error('producer failed:', err)
  process.exit(1)
})
```

Create `interop/scenarios/node-emit-python-consume/consumer.py` (uses `@on_event` + `RedisStreamConsumer`, asserts all fixtures arrive):

```python
"""Python consumer using @on_event + RedisStreamConsumer to receive the Node-produced
messages, asserting payload equality with the shared fixture."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import redis.asyncio as redis_asyncio

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "src"))

import json  # noqa: E402

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.redis_consumer import (  # noqa: E402
    RedisStreamConsumer,
)

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
STREAM = os.environ.get("INTEROP_STREAM", "interop")


async def main() -> int:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis_asyncio.from_url(url)

    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=STREAM, group="interop", consumer_name="w1"))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 10
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    for got, expected in zip(received, EXPECTED):
        assert got == expected["payload"], f"payload mismatch: {got!r} vs {expected['payload']!r}"

    print(f"consumer: received + matched {len(received)} messages via @on_event.")
    await client.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

Create `interop/scenarios/node-emit-python-consume/run.sh` (adapted from the existing scenario's run.sh):

```bash
#!/usr/bin/env bash
# Node producer → Python @on_event consumer over Redis Streams.
set -euo pipefail

cd "$(dirname "$0")/../../.."

cleanup() { docker compose -f interop/docker-compose.yml down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "${REDIS_URL:-}" ]; then
  docker compose -f interop/docker-compose.yml up -d redis >/dev/null
  for i in $(seq 1 30); do
    if docker compose -f interop/docker-compose.yml exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 0.5
  done
  export REDIS_URL="redis://localhost:6379"
fi
export INTEROP_STREAM="interop-${RANDOM}"

( cd node && pnpm install --frozen-lockfile >/dev/null && \
  pnpm exec tsx ../interop/scenarios/node-emit-python-consume/producer.ts )

( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/node-emit-python-consume/consumer.py
  else
    python3 -m pip install --quiet -e . redis >/dev/null
    python3 ../interop/scenarios/node-emit-python-consume/consumer.py
  fi )

echo "interop: node-emit / python-consume PASSED"
```

- [ ] **Step 2: Run the Node→Python scenario — expect PASS**

Run: `bash interop/scenarios/node-emit-python-consume/run.sh`
Expected: ends with `interop: node-emit / python-consume PASSED`.

- [ ] **Step 3: Write the Python→Node consume scenario**

Create `interop/scenarios/python-emit-node-consume/producer.py`:

```python
"""Python producer: writes the shared expected-payloads to a Redis stream as QueueMessage
JSON, matching RedisStreamAdapter's wire format (field 'data')."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import redis.asyncio as redis_asyncio

ROOT = Path(__file__).resolve().parents[3]
EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
STREAM = os.environ.get("INTEROP_STREAM", "interop")


async def main() -> int:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis_asyncio.from_url(url)
    for expected in EXPECTED:
        msg = {
            "eventName": expected["eventName"],
            "payload": expected["payload"],
            "timestamp": 1,
            "metadata": {"className": "OrderService", "methodName": "createOrder", "topic": "orders"},
        }
        await client.xadd(STREAM, {"data": json.dumps(msg, separators=(",", ":"))})
    print(f"producer: wrote {len(EXPECTED)} messages to stream {STREAM}")
    await client.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
```

Create `interop/scenarios/python-emit-node-consume/consumer.ts`:

```typescript
// Node consumer using @OnEvent + RedisStreamConsumer to receive Python-produced
// messages, asserting payload equality with the shared fixture.
import { readFileSync } from 'fs'
import { join } from 'path'
import Redis from 'ioredis'
import { ConsumerRegistry } from '../../../node/src/decorators/consumer-registry'
import { RedisStreamConsumer } from '../../../node/src/decorators/consumer-adapters'
import { OnEvent, registerHandlers } from '../../../node/src/decorators/on-event'

const ROOT = join(__dirname, '..', '..', '..')
const EXPECTED = (
  JSON.parse(readFileSync(join(ROOT, 'interop', 'shared', 'expected-payloads.json'), 'utf8')) as {
    messages: { eventName: string; payload: Record<string, unknown> }[]
  }
).messages
const STREAM = process.env.INTEROP_STREAM ?? 'interop'

const received: Record<string, unknown>[] = []
const reg = new ConsumerRegistry()

class Handlers {
  @OnEvent('OrderService.createOrder', { consumer: 'c', registry: reg })
  async onOrder(payload: Record<string, unknown>) {
    received.push(payload)
  }
}

async function main(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
  reg.register('c', new RedisStreamConsumer(client, { stream: STREAM, group: 'interop', consumerName: 'w1' }))
  registerHandlers(new Handlers())

  await reg.start()
  const deadline = Date.now() + 10_000
  while (received.length < EXPECTED.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  await reg.stop()

  if (received.length !== EXPECTED.length) {
    throw new Error(`expected ${EXPECTED.length} messages, got ${received.length}`)
  }
  for (let i = 0; i < received.length; i++) {
    if (JSON.stringify(received[i]) !== JSON.stringify(EXPECTED[i].payload)) {
      throw new Error(`payload mismatch at ${i}`)
    }
  }
  console.log(`consumer: received + matched ${received.length} messages via @OnEvent.`)
  await client.quit()
}

main().catch((err) => {
  console.error('consumer failed:', err)
  process.exit(1)
})
```

Create `interop/scenarios/python-emit-node-consume/run.sh`:

```bash
#!/usr/bin/env bash
# Python producer → Node @OnEvent consumer over Redis Streams.
set -euo pipefail

cd "$(dirname "$0")/../../.."

cleanup() { docker compose -f interop/docker-compose.yml down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -z "${REDIS_URL:-}" ]; then
  docker compose -f interop/docker-compose.yml up -d redis >/dev/null
  for i in $(seq 1 30); do
    if docker compose -f interop/docker-compose.yml exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
      break
    fi
    sleep 0.5
  done
  export REDIS_URL="redis://localhost:6379"
fi
export INTEROP_STREAM="interop-${RANDOM}"

( cd python && \
  if command -v uv >/dev/null 2>&1; then
    uv sync --extra dev >/dev/null
    uv run python ../interop/scenarios/python-emit-node-consume/producer.py
  else
    python3 -m pip install --quiet -e . redis >/dev/null
    python3 ../interop/scenarios/python-emit-node-consume/producer.py
  fi )

( cd node && pnpm install --frozen-lockfile >/dev/null && \
  pnpm exec tsx ../interop/scenarios/python-emit-node-consume/consumer.ts )

echo "interop: python-emit / node-consume PASSED"
```

- [ ] **Step 4: Run the Python→Node scenario — expect PASS**

Run: `bash interop/scenarios/python-emit-node-consume/run.sh`
Expected: ends with `interop: python-emit / node-consume PASSED`.

- [ ] **Step 5: Update interop README**

In `interop/README.md`, under the two existing scenario bullets, add:

```markdown
- `scenarios/node-emit-python-consume/` — Node writes to a Redis stream; Python consumes via `@on_event` + `RedisStreamConsumer` (consumer groups + XACK).
- `scenarios/python-emit-node-consume/` — reverse direction, Node consumes via `@OnEvent` + `RedisStreamConsumer`.
```

And update the "Adding a backend" closing note from "A BullMQ-aware Python consumer is tracked as a v2.1+ candidate." to:

```markdown
Kafka, BullMQ, and RabbitMQ consumers (and their interop scenarios) are added in Plan 2.
```

- [ ] **Step 6: Commit**

```bash
git add interop/scenarios/node-emit-python-consume/ interop/scenarios/python-emit-node-consume/ interop/README.md
git commit -m "test(interop): cross-language consume scenarios over Redis (@on_event/@OnEvent)"
```

---

## Task 12: Parity test — service-prefixed envelope round-trips identically

**Files:**
- Test: `python/tests/unit/test_queue_message_parity.py`
- Test: `node/src/decorators/queue-message-parity.spec.ts`

> Both load the new `contracts/fixtures/queue-message.valid-with-service.json` and assert their validation helper unwraps it to the same `(eventName, payload, metadata)`.

- [ ] **Step 1: Write the Python parity test**

Create `python/tests/unit/test_queue_message_parity.py`:

```python
import json
from pathlib import Path

from server_decorator.consumer.validate import validate_envelope

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "fixtures"
    / "queue-message.valid-with-service.json"
)


def test_service_envelope_unwraps() -> None:
    raw = json.loads(FIXTURE.read_text())
    event_name, payload, metadata = validate_envelope(raw)
    assert event_name == "UserService.create"
    assert payload == {"userId": "u-1", "email": "a@example.com"}
    assert metadata["service"] == "user-svc"
    assert metadata["topic"] == "user-svc.UserService.create"
```

- [ ] **Step 2: Run — expect PASS**

Run: `cd python && uv run pytest tests/unit/test_queue_message_parity.py -q`
Expected: PASS (1 passed).

- [ ] **Step 3: Write the Node parity test**

Create `node/src/decorators/queue-message-parity.spec.ts`:

```typescript
import { readFileSync } from 'fs'
import { join } from 'path'
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry'

const fixturePath = join(
  __dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'queue-message.valid-with-service.json',
)

describe('queue-message parity (service-prefixed envelope)', () => {
  it('unwraps to the same (eventName, payload, metadata) as Python', async () => {
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const got: Array<{ p: unknown; m: any }> = []
    const reg = new ConsumerRegistry()
    reg.register('c', new InMemoryConsumer([raw]))
    reg.on('UserService.create', (p, m) => { got.push({ p, m }) }, { consumer: 'c' })

    await reg.start()
    await new Promise((r) => setTimeout(r, 100))
    await reg.stop()

    expect(got).toHaveLength(1)
    expect(got[0].p).toEqual({ userId: 'u-1', email: 'a@example.com' })
    expect(got[0].m.service).toBe('user-svc')
    expect(got[0].m.topic).toBe('user-svc.UserService.create')
  })
})
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd node && pnpm test -- --testPathPattern=queue-message-parity`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add python/tests/unit/test_queue_message_parity.py node/src/decorators/queue-message-parity.spec.ts
git commit -m "test(parity): service-prefixed envelope unwraps identically in both languages"
```

---

## Task 13: Docs + ADR + full green sweep

**Files:**
- Create: `docs/adr/0013-cross-language-consumption.md` (use the next free ADR number if 0013 is taken)
- Modify: `node/README.md`
- Modify: `python/README.md`

- [ ] **Step 1: Determine the next ADR number**

Run: `ls docs/adr/`
Pick the next sequential number after the highest existing file. Use it in place of `0013` below.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/00NN-cross-language-consumption.md`:

```markdown
# 00NN. Cross-language consumption (consume side)

Status: Accepted (release 1.1)

## Context

v2.0 made the produce side polyglot (`@EmitOnSuccess` / `@emit_on_success`) but
shipped no consume side. Python could not consume Node's events; both relied on
raw clients in tests. We need a first-class consume API in both languages.

## Decision

- Mirror the produce side: `ConsumerAdapter` (per backend) → `ConsumerRegistry`
  (named consumers, explicit `start()`/`stop()`) → `@on_event` / `@OnEvent`
  (dispatch by `eventName`, handler receives `(payload, metadata)`).
- Delivery is **at-least-once** using each backend's native ack/redelivery; a
  handler that raises is not acked. Handlers MUST be idempotent. Ordering is not
  guaranteed.
- Unmatched events are acked + skipped (debug log); `on_unhandled` overrides.
  Invalid envelopes are acked + routed to `on_invalid` (warn + skip default).
- Opt-in service prefix: `SERVER_DECORATOR_SERVICE` / `configure(service=...)`
  makes the auto-topic `service.ClassName.methodName` and stamps
  `metadata.service`. Additive minor contract bump (1.1.0); the cache-key
  contract is untouched.

## Consequences

- Lockstep symmetry: anyone who knows the produce side knows the consume side.
- BullMQ-as-BullMQ consumption (Plan 2) needs no contract change; cross-adapter
  framing remains an explicit non-goal (would force a major bump).
- Plan 1 ships Redis; Kafka/BullMQ/RabbitMQ consumers land in Plan 2.
```

- [ ] **Step 3: Add a consume section to `python/README.md`**

Append (or place near the queue section) the following:

````markdown
## Consuming events

```python
from server_decorator import ConsumerRegistry, on_event
from server_decorator.consumer.adapters.redis_consumer import RedisStreamConsumer
import redis.asyncio as redis

registry = ConsumerRegistry()
registry.register("orders", RedisStreamConsumer(redis.from_url("redis://localhost:6379"),
                                                stream="orders", group="email-svc"))

@on_event("OrderService.createOrder", consumer="orders")
async def send_email(payload, meta):
    ...  # return → ack; raise → redelivered

await registry.start()
# ... app runs ...
await registry.stop()
```

**Delivery is at-least-once.** A message can be delivered more than once (e.g. a
crash between handler success and ack). **Handlers must be idempotent.** Ordering
is not guaranteed under redelivery.
````

- [ ] **Step 4: Add a consume section to `node/README.md`**

Append the following:

````markdown
## Consuming events

```typescript
import { ConsumerRegistry, RedisStreamConsumer, OnEvent, registerHandlers } from '@montionugera/server-decorator'
import Redis from 'ioredis'

const registry = new ConsumerRegistry()
registry.register('orders', new RedisStreamConsumer(new Redis('redis://localhost:6379'), { stream: 'orders', group: 'email-svc' }))

class OrderHandlers {
  @OnEvent('OrderService.createOrder', { consumer: 'orders' })
  async sendEmail(payload: any, meta: any) {
    // return → ack; throw → redelivered
  }
}
registerHandlers(new OrderHandlers())

await registry.start()
// ... app runs ...
await registry.stop()
```

**Delivery is at-least-once** — handlers must be idempotent; ordering is not
guaranteed under redelivery.
````

- [ ] **Step 5: Full green sweep (both languages)**

Run: `cd python && bash scripts/check.sh`
Expected: ruff + ruff format + mypy strict + pytest unit all pass.

Run: `cd node && pnpm test:unit && pnpm run build`
Expected: all unit tests pass, build exit 0.

Run: `bash contracts/scripts/validate.sh`
Expected: `All contract fixtures validate.`

- [ ] **Step 6: Commit**

```bash
git add docs/adr/ node/README.md python/README.md
git commit -m "docs: ADR + READMEs for cross-language consumption (consume side)"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3 architecture (adapter/registry/decorator, explicit lifecycle) → Tasks 4, 5, 6, 8, 9 ✓
- §4 API (`@on_event`/`@OnEvent`, `(payload, metadata)`, `consumer=`, Node class-form opt-in) → Tasks 6, 9 ✓
- §5 delivery (at-least-once, ack-on-return/no-ack-on-raise, unmatched ack+skip, on_invalid, ordering caveat) → Tasks 5, 7, 8, 10, 13 ✓
- §6 contract (service prefix, metadata.service, 3-segment regex, minor VERSION bump, both _contract files) → Task 1; producer wiring Tasks 2, 3, 9 ✓
- §7 testing (unit via InMemoryConsumer, parity, integration, interop) → Tasks 4–12 ✓
- §8 scope (Redis only this plan; Kafka/BullMQ/RabbitMQ deferred to Plan 2) → stated in header + README (Task 11/13) ✓
- BullMQ via official package, Kafka, RabbitMQ → **Plan 2** (out of scope here, by design) ✓

**Placeholder scan:** One intentional `00NN`/`0013` ADR-number placeholder in Task 13 with an explicit Step 1 to resolve it — not a content gap. The `//` typo guard in Task 4 Step 3 is called out with a fix instruction. No other TBD/TODO.

**Type consistency:** `Dispatch`, `ConsumerAdapter`, `EventHandler`/`Handler`, `dispatchFor`/`_dispatch_for`, `RegisterOptions.onUnhandled`/`onInvalid`, `on_unhandled`/`on_invalid`, `RedisStreamConsumer` constructor options (`stream`/`group`/`consumerName` vs `consumer_name`) are used consistently within each language. `registerHandlers` + `OnEvent` pairing matches across Tasks 9, 11, 12.

**Deferred to Plan 2 (not gaps):** Kafka/BullMQ/RabbitMQ consumer adapters + their integration & interop scenarios.

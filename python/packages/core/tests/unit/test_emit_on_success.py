"""Unit tests for @emit_on_success and emit_on_success_class."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from server_decorator import (
    InMemoryQueueAdapter,
    emit_on_success,
    emit_on_success_class,
    global_emitter,
    global_queue_registry,
)


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    global_queue_registry.clear()


async def test_async_event_emitted() -> None:
    received: list[Any] = []
    global_emitter.on("Svc.go", lambda payload: received.append(payload))

    class Svc:
        @emit_on_success(use_events=True)
        async def go(self) -> dict:
            return {"x": 1}

    out = await Svc().go()
    assert out == {"x": 1}
    assert received == [{"x": 1}]


async def test_async_queue_publish() -> None:
    a = InMemoryQueueAdapter()
    global_queue_registry.register("mem", a)

    class Svc:
        @emit_on_success(use_queue=True, use_events=False, queue="mem")
        async def go(self, customer_id: str) -> dict:
            return {"customer_id": customer_id}

    await Svc().go("cust-1")
    msgs = a.messages.get("Svc.go", [])
    assert len(msgs) == 1
    assert msgs[0]["eventName"] == "Svc.go"
    assert msgs[0]["payload"] == {"customer_id": "cust-1"}
    assert isinstance(msgs[0]["timestamp"], int) and msgs[0]["timestamp"] > 0


async def test_transform_applied() -> None:
    a = InMemoryQueueAdapter()
    global_queue_registry.register("mem", a)

    class Svc:
        @emit_on_success(
            use_queue=True,
            use_events=False,
            queue="mem",
            transform=lambda r: {"only_id": r["id"]},
        )
        async def go(self) -> dict:
            return {"id": "abc", "secret": "redacted"}

    await Svc().go()
    body = a.messages["Svc.go"][0]
    assert body["payload"] == {"only_id": "abc"}


async def test_custom_event_name() -> None:
    received: list[Any] = []
    global_emitter.on("custom.event", lambda payload: received.append(payload))

    class Svc:
        @emit_on_success(use_events=True, event_name="custom.event")
        async def go(self) -> int:
            return 42

    await Svc().go()
    assert received == [42]


def test_sync_method_does_not_block_caller() -> None:
    """D-C: sync method outside a loop must not block the caller while emitting."""
    a = InMemoryQueueAdapter()
    global_queue_registry.register("mem", a)

    sleeps: list[None] = []

    class SlowAdapter:
        async def publish(self, message: dict[str, Any]) -> None:  # type: ignore[override]
            await asyncio.sleep(0.2)
            sleeps.append(None)
            await a.publish(message)  # type: ignore[arg-type]

    global_queue_registry.clear()
    global_queue_registry.register("slow", SlowAdapter())

    class Svc:
        @emit_on_success(use_queue=True, use_events=False, queue="slow")
        def go(self) -> int:
            return 1

    t0 = time.perf_counter()
    Svc().go()
    elapsed = time.perf_counter() - t0
    assert elapsed < 0.05, (
        f"sync caller blocked for {elapsed:.3f}s — D-C executor should make this fire-and-forget"
    )


async def test_class_form() -> None:
    a = InMemoryQueueAdapter()
    global_queue_registry.register("mem", a)

    @emit_on_success_class(use_queue=True, use_events=False, queue="mem")
    class Inv:
        async def restock(self, sku: str) -> dict:
            return {"sku": sku, "kind": "restock"}

        async def reserve(self, sku: str) -> dict:
            return {"sku": sku, "kind": "reserve"}

        def _internal(self, sku: str) -> bool:
            return True

    s = Inv()
    await s.restock("WIDGET-1")
    await s.reserve("WIDGET-1")
    s._internal("WIDGET-1")  # MUST NOT publish

    event_names = sorted(m["eventName"] for ms in a.messages.values() for m in ms)
    assert event_names == ["Inv.reserve", "Inv.restock"]

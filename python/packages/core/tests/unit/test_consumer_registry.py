from __future__ import annotations

import asyncio
import logging

import pytest

from server_decorator.consumer.adapter import Dispatch
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


class _FailingRunAdapter:
    async def run(self, dispatch: Dispatch) -> None:
        raise RuntimeError("boom")

    async def stop(self) -> None:
        pass


async def test_stop_handles_crashed_consumer_task_without_double_logging(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.ERROR, logger="server_decorator.consumer")
    reg = ConsumerRegistry()
    reg.register("failing", _FailingRunAdapter())

    await reg.start()
    for _ in range(3):
        await asyncio.sleep(0)
    await reg.stop()

    records = [
        r
        for r in caplog.records
        if r.name == "server_decorator.consumer"
        and r.levelname == "ERROR"
        and r.getMessage() == "consumer task terminated with exception"
    ]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert isinstance(records[0].exc_info[1], RuntimeError)
    assert str(records[0].exc_info[1]) == "boom"

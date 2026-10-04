"""Regression tests for the emit / queues / consumers hardening pass.

Covers: Kafka redelivery of a failed offset, a throwing transform, the sync
emit path's event loop, and the topic-naming contract cases shared with Node.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import server_decorator.config as cfg
from server_decorator import (
    InMemoryQueueAdapter,
    emit_on_success,
    global_emitter,
    global_queue_registry,
)
from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer
from server_decorator.queue.message import QueueMessage

_FIXTURES = Path(__file__).resolve().parents[5] / "contracts" / "fixtures"
_FIXTURE = _FIXTURES / "topic-naming.cases.json"
_CASES: list[dict[str, Any]] = json.loads(_FIXTURE.read_text())["cases"]


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    global_queue_registry.clear()
    yield
    global_queue_registry.clear()


def _all_messages(adapter: InMemoryQueueAdapter) -> list[QueueMessage]:
    return [m for msgs in adapter.messages.values() for m in msgs]


# --------------------------------------------------------------------------- Kafka


class _Record:
    def __init__(self, offset: int) -> None:
        self.offset = offset
        self.value = json.dumps(offset).encode()


class _FakeAIOKafkaConsumer:
    """One partition; getmany hands out up to max_records from the fetch position."""

    instance: _FakeAIOKafkaConsumer
    log_size = 6
    on_exhausted: Any = None

    def __init__(self, *topics: str, **_kwargs: Any) -> None:
        self.position = 0
        self.commits: list[int] = []
        type(self).instance = self

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def getmany(self, *, timeout_ms: int, max_records: int) -> dict[Any, list[_Record]]:
        if self.position >= self.log_size:
            await type(self).on_exhausted()
            return {}
        end = min(self.position + max_records, self.log_size)
        records = [_Record(o) for o in range(self.position, end)]
        self.position = end
        return {("t", 0): records}

    def seek(self, tp: Any, offset: int) -> None:
        self.position = offset

    async def commit(self, offsets: dict[Any, int]) -> None:
        self.commits.extend(offsets.values())


@pytest.fixture
def fake_aiokafka(monkeypatch: pytest.MonkeyPatch) -> type[_FakeAIOKafkaConsumer]:
    module = types.ModuleType("aiokafka")
    module.AIOKafkaConsumer = _FakeAIOKafkaConsumer  # type: ignore[attr-defined]
    module.TopicPartition = tuple  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "aiokafka", module)
    return _FakeAIOKafkaConsumer


async def test_kafka_failed_offset_is_redelivered_and_never_committed_past(
    fake_aiokafka: type[_FakeAIOKafkaConsumer],
) -> None:
    consumer = KafkaConsumer("fake:9092", topics=["t"], retry_backoff_ms=0)
    fake_aiokafka.on_exhausted = consumer.stop

    dispatched: list[int] = []
    commits_at_failure: list[list[int]] = []
    failed_once = False

    async def dispatch(raw: Any) -> None:
        nonlocal failed_once
        dispatched.append(raw)
        if raw == 1 and not failed_once:
            failed_once = True
            commits_at_failure.append(list(fake_aiokafka.instance.commits))
            raise RuntimeError("handler boom")

    await asyncio.wait_for(consumer.run(dispatch), timeout=5)

    assert dispatched == [0, 1, 1, 2, 3, 4, 5]
    assert commits_at_failure == [[1]]
    # Commits advance one record at a time: nothing ever jumped over offset 1.
    assert fake_aiokafka.instance.commits == [1, 2, 3, 4, 5, 6]


async def test_kafka_retry_backoff_is_interrupted_by_stop(
    fake_aiokafka: type[_FakeAIOKafkaConsumer],
) -> None:
    consumer = KafkaConsumer("fake:9092", topics=["t"], retry_backoff_ms=60_000)
    fake_aiokafka.on_exhausted = consumer.stop

    async def dispatch(raw: Any) -> None:
        asyncio.get_running_loop().call_later(0.05, consumer._stop.set)
        raise RuntimeError("always fails")

    await asyncio.wait_for(consumer.run(dispatch), timeout=5)

    assert fake_aiokafka.instance.commits == []
    assert fake_aiokafka.instance.position == 0


# ----------------------------------------------------------------------- transform


async def test_throwing_transform_does_not_fail_async_method() -> None:
    adapter = InMemoryQueueAdapter()
    global_queue_registry.register("q", adapter)
    received: list[Any] = []
    global_emitter.on("TransformSvc.save", received.append)

    class TransformSvc:
        @emit_on_success(use_queue=True, queue="q", transform=lambda r: r["missing"])
        async def save(self) -> dict[str, int]:
            return {"id": 7}

    assert await TransformSvc().save() == {"id": 7}
    assert received == []
    assert _all_messages(adapter) == []


async def test_throwing_transform_in_sync_method_inside_loop_is_contained() -> None:
    adapter = InMemoryQueueAdapter()
    global_queue_registry.register("q", adapter)
    loop = asyncio.get_running_loop()
    unhandled: list[dict[str, Any]] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, ctx: unhandled.append(ctx))

    class TransformSyncSvc:
        @emit_on_success(use_queue=True, queue="q", transform=lambda r: r["missing"])
        def save(self) -> dict[str, int]:
            return {"id": 7}

    try:
        assert TransformSyncSvc().save() == {"id": 7}
        await asyncio.sleep(0.05)
        import gc

        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous)
    assert unhandled == []
    assert _all_messages(adapter) == []


# ------------------------------------------------------------------ sync emit loop


def test_sync_emit_outside_loop_reuses_one_open_event_loop() -> None:
    seen: list[tuple[asyncio.AbstractEventLoop, bool]] = []

    class LoopBoundAdapter:
        """Like a real asyncio client: unusable once its first loop is closed."""

        def __init__(self) -> None:
            self.loop: asyncio.AbstractEventLoop | None = None

        async def publish(self, message: QueueMessage) -> None:
            current = asyncio.get_running_loop()
            if self.loop is None:
                self.loop = current
            seen.append((current, self.loop.is_closed()))

    global_queue_registry.register("q", LoopBoundAdapter())

    class SyncSvc:
        @emit_on_success(use_events=False, use_queue=True, queue="q")
        def go(self, n: int) -> int:
            return n

    svc = SyncSvc()
    for n in range(3):
        assert svc.go(n) == n

    deadline = time.monotonic() + 5
    while len(seen) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)

    assert len(seen) == 3
    assert len({id(loop) for loop, _ in seen}) == 1
    assert [closed for _, closed in seen] == [False, False, False]


# ------------------------------------------------------------ topic-naming contract


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
async def test_topic_naming_contract_cases(case: dict[str, Any]) -> None:
    cfg.configure(service=case["service"])
    adapter = InMemoryQueueAdapter()
    global_queue_registry.register("q", adapter)

    async def method(self: Any) -> str:
        return "ok"

    method.__name__ = case["methodName"]
    method.__qualname__ = f"{case['className']}.{case['methodName']}"
    decorated = emit_on_success(
        use_events=False,
        use_queue=True,
        queue="q",
        event_name=case["eventName"],
        topic=case["topic"],
    )(method)
    cls = type(case["className"], (), {case["methodName"]: decorated})

    await getattr(cls(), case["methodName"])()

    messages = _all_messages(adapter)
    assert len(messages) == 1
    assert messages[0]["eventName"] == case["expectedEventName"]
    assert messages[0]["metadata"]["topic"] == case["expectedTopic"]

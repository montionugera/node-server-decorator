"""Unit coverage for BullMQConsumer with a fake `bullmq` module injected at the import
boundary (no Redis, no real Worker)."""

from __future__ import annotations

import asyncio
import sys
import types
from typing import Any, ClassVar

import pytest

from server_decorator.consumer.adapters.bullmq_consumer import BullMQConsumer


class _FakeWorker:
    instances: ClassVar[list[_FakeWorker]] = []

    def __init__(self, name: str, processor: Any, opts: dict[str, Any]) -> None:
        self.name = name
        self.processor = processor
        self.opts = opts
        self.closed = 0
        _FakeWorker.instances.append(self)

    async def close(self) -> None:
        self.closed += 1


class _Job:
    def __init__(self, data: Any) -> None:
        self.data = data


@pytest.fixture
def fake_bullmq(monkeypatch: pytest.MonkeyPatch) -> type[_FakeWorker]:
    _FakeWorker.instances = []
    module = types.ModuleType("bullmq")
    module.Worker = _FakeWorker  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "bullmq", module)
    return _FakeWorker


async def _started(consumer: BullMQConsumer, dispatch: Any) -> asyncio.Task[None]:
    task = asyncio.create_task(consumer.run(dispatch))
    for _ in range(50):
        if _FakeWorker.instances:
            break
        await asyncio.sleep(0)
    return task


async def test_run_creates_worker_with_queue_connection_and_concurrency(
    fake_bullmq: type[_FakeWorker],
) -> None:
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h:6379", concurrency=4)

    async def dispatch(raw: Any) -> None:
        return None

    task = await _started(consumer, dispatch)

    assert len(fake_bullmq.instances) == 1
    worker = fake_bullmq.instances[0]
    assert worker.name == "jobs"
    assert worker.opts == {"connection": "redis://h:6379", "concurrency": 4}
    assert not task.done()  # run() blocks until stop()

    await consumer.stop()
    await asyncio.wait_for(task, timeout=2)
    assert worker.closed == 1


async def test_concurrency_defaults_to_one(fake_bullmq: type[_FakeWorker]) -> None:
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h")

    async def dispatch(raw: Any) -> None:
        return None

    task = await _started(consumer, dispatch)
    assert fake_bullmq.instances[0].opts["concurrency"] == 1
    await consumer.stop()
    await asyncio.wait_for(task, timeout=2)


async def test_processor_dispatches_job_data(fake_bullmq: type[_FakeWorker]) -> None:
    got: list[Any] = []
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h")

    async def dispatch(raw: Any) -> None:
        got.append(raw)

    task = await _started(consumer, dispatch)
    envelope = {"eventName": "A.x", "payload": {"n": 1}, "timestamp": 1}

    result = await fake_bullmq.instances[0].processor(_Job(envelope), "token-1")

    assert result is None  # normal return => BullMQ marks the job completed
    assert got == [envelope]
    await consumer.stop()
    await asyncio.wait_for(task, timeout=2)


async def test_processor_reraises_dispatch_failure_so_bullmq_retries(
    fake_bullmq: type[_FakeWorker],
) -> None:
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h")

    async def dispatch(raw: Any) -> None:
        raise RuntimeError("handler boom")

    task = await _started(consumer, dispatch)

    with pytest.raises(RuntimeError, match="handler boom"):
        await fake_bullmq.instances[0].processor(_Job({"eventName": "A.x"}), "token-1")

    await consumer.stop()
    await asyncio.wait_for(task, timeout=2)


async def test_stop_before_run_does_not_close_a_worker(fake_bullmq: type[_FakeWorker]) -> None:
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h")

    await consumer.stop()  # no worker yet: must not raise

    assert fake_bullmq.instances == []

    async def dispatch(raw: Any) -> None:
        return None

    # stop flag already set => run() builds the worker and returns immediately
    await asyncio.wait_for(consumer.run(dispatch), timeout=2)
    assert len(fake_bullmq.instances) == 1
    assert fake_bullmq.instances[0].closed == 0


async def test_run_raises_import_error_when_bullmq_extra_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "bullmq", None)  # makes `from bullmq import ...` fail
    consumer = BullMQConsumer(queue_name="jobs", connection="redis://h")

    async def dispatch(raw: Any) -> None:
        return None

    with pytest.raises(ImportError):
        await consumer.run(dispatch)

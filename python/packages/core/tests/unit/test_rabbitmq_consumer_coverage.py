"""Unit coverage for RabbitMQConsumer using a fake aio-pika channel (no real broker)."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from server_decorator.consumer.adapters.rabbitmq_consumer import RabbitMQConsumer


class _FakeMessage:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.acked = 0
        self.nacked: list[bool] = []

    async def ack(self) -> None:
        self.acked += 1

    async def nack(self, requeue: bool = False) -> None:
        self.nacked.append(requeue)


class _FakeIterator:
    def __init__(self, messages: list[_FakeMessage]) -> None:
        self._messages = list(messages)
        self.entered = False
        self.exited = False
        self.yielded = 0

    async def __aenter__(self) -> _FakeIterator:
        self.entered = True
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self.exited = True

    def __aiter__(self) -> _FakeIterator:
        return self

    async def __anext__(self) -> _FakeMessage:
        if not self._messages:
            raise StopAsyncIteration
        self.yielded += 1
        return self._messages.pop(0)


class _FakeQueue:
    def __init__(self, it: _FakeIterator) -> None:
        self._it = it

    def iterator(self) -> _FakeIterator:
        return self._it


class _FakeChannel:
    def __init__(self, messages: list[_FakeMessage]) -> None:
        self.it = _FakeIterator(messages)
        self.qos: list[int] = []
        self.declared: list[tuple[str, bool]] = []

    async def set_qos(self, prefetch_count: int) -> None:
        self.qos.append(prefetch_count)

    async def declare_queue(self, name: str, durable: bool = False) -> _FakeQueue:
        self.declared.append((name, durable))
        return _FakeQueue(self.it)


async def test_run_sets_qos_declares_durable_queue_and_acks_on_success() -> None:
    msgs = [_FakeMessage(b'{"eventName":"a"}'), _FakeMessage(b'{"eventName":"b"}')]
    channel = _FakeChannel(msgs)
    seen: list[Any] = []

    async def dispatch(raw: Any) -> None:
        seen.append(raw)

    await RabbitMQConsumer(channel, queue="events", prefetch=3).run(dispatch)

    assert channel.qos == [3]
    assert channel.declared == [("events", True)]
    assert seen == [{"eventName": "a"}, {"eventName": "b"}]
    assert [m.acked for m in msgs] == [1, 1]
    assert [m.nacked for m in msgs] == [[], []]
    assert channel.it.entered and channel.it.exited


async def test_default_prefetch_is_ten() -> None:
    channel = _FakeChannel([])
    called = False

    async def dispatch(raw: Any) -> None:
        nonlocal called
        called = True

    await RabbitMQConsumer(channel, queue="q").run(dispatch)

    assert channel.qos == [10]
    assert called is False


async def test_unparseable_body_is_acked_dropped_and_not_dispatched(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bad = _FakeMessage(b"{not json")
    good = _FakeMessage(b'{"ok":true}')
    seen: list[Any] = []

    async def dispatch(raw: Any) -> None:
        seen.append(raw)

    with caplog.at_level(logging.ERROR, logger="server_decorator.consumer"):
        await RabbitMQConsumer(_FakeChannel([bad, good]), queue="q").run(dispatch)

    assert bad.acked == 1 and bad.nacked == []
    assert seen == [{"ok": True}]
    assert good.acked == 1
    assert any("unparseable rabbitmq message" in r.getMessage() for r in caplog.records)


async def test_dispatch_failure_nacks_with_requeue_and_continues(
    caplog: pytest.LogCaptureFixture,
) -> None:
    failing = _FakeMessage(b'{"n":1}')
    ok = _FakeMessage(b'{"n":2}')

    async def dispatch(raw: Any) -> None:
        if raw["n"] == 1:
            raise RuntimeError("handler boom")

    with caplog.at_level(logging.ERROR, logger="server_decorator.consumer"):
        await RabbitMQConsumer(_FakeChannel([failing, ok]), queue="q").run(dispatch)

    assert failing.nacked == [True]
    assert failing.acked == 0
    assert ok.acked == 1 and ok.nacked == []
    assert any("dispatch failed" in r.getMessage() for r in caplog.records)


async def test_stop_before_run_breaks_without_dispatch_or_ack() -> None:
    msgs = [_FakeMessage(b'{"n":1}'), _FakeMessage(b'{"n":2}')]
    channel = _FakeChannel(msgs)
    seen: list[Any] = []

    async def dispatch(raw: Any) -> None:
        seen.append(raw)

    consumer = RabbitMQConsumer(channel, queue="q")
    await consumer.stop()
    await consumer.run(dispatch)

    assert seen == []
    assert [m.acked for m in msgs] == [0, 0]
    assert [m.nacked for m in msgs] == [[], []]
    # It stops at the first delivery rather than draining the iterator.
    assert channel.it.yielded == 1
    assert channel.it.exited


async def test_stop_during_dispatch_finishes_current_message_then_exits() -> None:
    msgs = [_FakeMessage(b'{"n":1}'), _FakeMessage(b'{"n":2}'), _FakeMessage(b'{"n":3}')]
    seen: list[int] = []
    consumer = RabbitMQConsumer(_FakeChannel(msgs), queue="q")

    async def dispatch(raw: Any) -> None:
        seen.append(raw["n"])
        await consumer.stop()

    await consumer.run(dispatch)

    assert seen == [1]
    assert [m.acked for m in msgs] == [1, 0, 0]


async def test_stop_is_idempotent() -> None:
    consumer = RabbitMQConsumer(_FakeChannel([]), queue="q")

    await consumer.stop()
    await consumer.stop()

    assert consumer._stop.is_set()

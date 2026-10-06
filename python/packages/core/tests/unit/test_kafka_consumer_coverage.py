"""Unit tests for KafkaConsumer.run with a fake aiokafka consumer (no broker)."""

from __future__ import annotations

import json
from typing import Any, NamedTuple

import aiokafka
import pytest

from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer


class _Record(NamedTuple):
    offset: int
    value: Any


class _FakeConsumer:
    """Serves scripted batches; a seek rewinds the script like a real fetch position."""

    last: _FakeConsumer

    def __init__(self, *topics: str, **kwargs: Any) -> None:
        self.topics = topics
        self.kwargs = kwargs
        self.started = False
        self.stopped = False
        self.commits: list[dict[Any, int]] = []
        self.seeks: list[tuple[Any, int]] = []
        self.batches: list[dict[Any, list[_Record]]] = []
        self.polls = 0
        self.on_idle: Any = None
        _FakeConsumer.last = self

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def getmany(self, *, timeout_ms: int, max_records: int) -> dict[Any, list[_Record]]:
        self.polls += 1
        if self.batches:
            return self.batches.pop(0)
        if self.on_idle is not None:
            await self.on_idle()
        return {}

    async def commit(self, offsets: dict[Any, int]) -> None:
        self.commits.append(offsets)

    def seek(self, tp: Any, offset: int) -> None:
        self.seeks.append((tp, offset))


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> type[_FakeConsumer]:
    monkeypatch.setattr(aiokafka, "AIOKafkaConsumer", _FakeConsumer)
    return _FakeConsumer


async def _run(
    consumer: KafkaConsumer,
    batches: list[dict[Any, list[_Record]]],
    dispatch: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> _FakeConsumer:
    """Run until the scripted batches are drained, then stop."""
    orig_start = _FakeConsumer.start

    async def start(self: _FakeConsumer) -> None:
        await orig_start(self)
        self.batches = list(batches)
        self.on_idle = consumer.stop

    monkeypatch.setattr(_FakeConsumer, "start", start)
    await consumer.run(dispatch)
    return _FakeConsumer.last


async def test_constructor_options_reach_the_aiokafka_consumer(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    consumer = KafkaConsumer(
        "broker:9092", topics=["a", "b"], group_id="g1", auto_offset_reset="latest"
    )

    async def dispatch(raw: Any) -> None:  # pragma: no cover - no records
        raise AssertionError("no records expected")

    inst = await _run(consumer, [], dispatch, monkeypatch)

    assert inst.topics == ("a", "b")
    assert inst.kwargs == {
        "bootstrap_servers": "broker:9092",
        "group_id": "g1",
        "enable_auto_commit": False,
        "auto_offset_reset": "latest",
    }
    assert inst.started is True
    assert inst.stopped is True
    assert inst.commits == []


async def test_success_commits_next_offset_per_record(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    tp = aiokafka.TopicPartition("t", 0)
    seen: list[Any] = []

    async def dispatch(raw: Any) -> None:
        seen.append(raw)

    batch = {tp: [_Record(7, json.dumps({"n": 1})), _Record(8, json.dumps({"n": 2}).encode())]}
    inst = await _run(KafkaConsumer("b", topics=["t"]), [batch], dispatch, monkeypatch)

    assert seen == [{"n": 1}, {"n": 2}]
    assert inst.commits == [{tp: 8}, {tp: 9}]
    assert inst.seeks == []


async def test_unparseable_record_is_committed_and_skipped(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    tp = aiokafka.TopicPartition("t", 0)
    seen: list[Any] = []

    async def dispatch(raw: Any) -> None:
        seen.append(raw)

    batch = {tp: [_Record(0, b"{not json"), _Record(1, None), _Record(2, b'{"ok":true}')]}
    with caplog.at_level("ERROR", logger="server_decorator.consumer"):
        inst = await _run(KafkaConsumer("b", topics=["t"]), [batch], dispatch, monkeypatch)

    # Poison records never reach the handler but are committed past, so they are not replayed.
    assert seen == [{"ok": True}]
    assert inst.commits == [{tp: 1}, {tp: 2}, {tp: 3}]
    assert inst.seeks == []
    assert sum("unparseable kafka record" in r.message for r in caplog.records) == 2


async def test_dispatch_failure_seeks_back_and_never_commits_past_it(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    tp = aiokafka.TopicPartition("t", 0)
    other = aiokafka.TopicPartition("t", 1)
    attempts: list[Any] = []

    async def dispatch(raw: Any) -> None:
        attempts.append(raw)
        if raw == {"n": 2}:
            raise RuntimeError("handler down")

    batch = {
        tp: [_Record(1, '{"n":1}'), _Record(2, '{"n":2}'), _Record(3, '{"n":3}')],
        other: [_Record(40, '{"n":40}')],
    }
    inst = await _run(
        KafkaConsumer("b", topics=["t"], retry_backoff_ms=0), [batch], dispatch, monkeypatch
    )

    # Offset 3 on the failed partition is neither dispatched nor committed; the other
    # partition is unaffected.
    assert attempts == [{"n": 1}, {"n": 2}, {"n": 40}]
    assert inst.seeks == [(tp, 2)]
    assert inst.commits == [{tp: 2}, {other: 41}]
    assert inst.stopped is True


async def test_retry_backoff_is_interrupted_by_stop(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    tp = aiokafka.TopicPartition("t", 0)
    consumer = KafkaConsumer("b", topics=["t"], retry_backoff_ms=60_000)

    async def dispatch(raw: Any) -> None:
        await consumer.stop()
        raise RuntimeError("fail while stopping")

    inst = await _run(consumer, [{tp: [_Record(5, "{}")]}], dispatch, monkeypatch)

    # A 60s backoff would hang the test: stop() must cut the wait short.
    assert inst.seeks == [(tp, 5)]
    assert inst.commits == []
    assert inst.polls == 1
    assert inst.stopped is True


async def test_retry_backoff_elapses_then_polls_again(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    tp = aiokafka.TopicPartition("t", 0)
    calls = 0

    async def dispatch(raw: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("transient")

    batches = [{tp: [_Record(5, "{}")]}, {tp: [_Record(5, "{}")]}]
    inst = await _run(
        KafkaConsumer("b", topics=["t"], retry_backoff_ms=1), batches, dispatch, monkeypatch
    )

    assert calls == 2
    assert inst.seeks == [(tp, 5)]
    assert inst.commits == [{tp: 6}]


async def test_consumer_is_stopped_when_poll_raises(
    fake: type[_FakeConsumer], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(self: _FakeConsumer, **_: Any) -> dict[Any, Any]:
        raise ConnectionError("broker gone")

    monkeypatch.setattr(_FakeConsumer, "getmany", boom)

    async def dispatch(raw: Any) -> None:  # pragma: no cover
        raise AssertionError("unreachable")

    with pytest.raises(ConnectionError, match="broker gone"):
        await KafkaConsumer("b", topics=["t"]).run(dispatch)
    assert _FakeConsumer.last.started is True
    assert _FakeConsumer.last.stopped is True


async def test_stop_before_run_exits_without_polling(fake: type[_FakeConsumer]) -> None:
    consumer = KafkaConsumer("b", topics=["t"])
    await consumer.stop()

    async def dispatch(raw: Any) -> None:  # pragma: no cover
        raise AssertionError("unreachable")

    await consumer.run(dispatch)
    assert _FakeConsumer.last.polls == 0
    assert _FakeConsumer.last.stopped is True

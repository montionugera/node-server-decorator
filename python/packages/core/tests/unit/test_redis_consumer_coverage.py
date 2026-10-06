"""Unit coverage for RedisStreamConsumer with a fake redis client (no Redis server)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import pytest

from server_decorator.consumer.adapters.redis_consumer import RedisStreamConsumer


class _FakeRedis:
    """Serves scripted XREADGROUP responses, then asks the consumer to stop."""

    def __init__(self, responses: list[Any], group_error: Exception | None = None) -> None:
        self._responses = list(responses)
        self._group_error = group_error
        self.consumer: RedisStreamConsumer | None = None
        self.group_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.read_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.acked: list[tuple[str, str, Any]] = []

    async def xgroup_create(self, *args: Any, **kwargs: Any) -> None:
        self.group_calls.append((args, kwargs))
        if self._group_error is not None:
            raise self._group_error

    async def xreadgroup(self, *args: Any, **kwargs: Any) -> Any:
        self.read_calls.append((args, kwargs))
        if not self._responses:
            assert self.consumer is not None
            await self.consumer.stop()
            return []
        return self._responses.pop(0)

    async def xack(self, stream: str, group: str, entry_id: Any) -> None:
        self.acked.append((stream, group, entry_id))


def _run(client: _FakeRedis, **kwargs: Any) -> RedisStreamConsumer:
    consumer = RedisStreamConsumer(client, **kwargs)
    client.consumer = consumer
    return consumer


def _envelope(n: int) -> dict[str, Any]:
    return {"eventName": "A.x", "payload": n, "timestamp": 1}


async def test_dispatches_and_acks_entries_in_order() -> None:
    client = _FakeRedis(
        [
            [
                (
                    b"s",
                    [
                        (b"1-0", {b"data": json.dumps(_envelope(1)).encode()}),
                        ("2-0", {"data": json.dumps(_envelope(2))}),  # decode_responses=True shape
                    ],
                )
            ]
        ]
    )
    got: list[Any] = []

    async def dispatch(raw: Any) -> None:
        got.append(raw)

    await asyncio.wait_for(_run(client, stream="s", group="g").run(dispatch), timeout=2)

    assert got == [_envelope(1), _envelope(2)]
    assert client.acked == [("s", "g", b"1-0"), ("s", "g", "2-0")]


async def test_creates_group_and_reads_with_configured_options() -> None:
    client = _FakeRedis([])

    async def dispatch(raw: Any) -> None:
        raise AssertionError("no entries expected")

    consumer = _run(client, stream="s", group="g", consumer_name="c9", block_ms=250, batch=3)
    await asyncio.wait_for(consumer.run(dispatch), timeout=2)

    assert client.group_calls == [(("s", "g"), {"id": "0", "mkstream": True})]
    assert client.read_calls == [(("g", "c9", {"s": ">"}), {"count": 3, "block": 250})]
    assert client.acked == []


async def test_defaults_match_producer_stream_and_group() -> None:
    client = _FakeRedis([])

    async def dispatch(raw: Any) -> None:
        return None

    await asyncio.wait_for(_run(client).run(dispatch), timeout=2)

    assert client.group_calls[0][0] == ("default", "server-decorator")
    assert client.read_calls[0] == (
        ("server-decorator", "consumer-1", {"default": ">"}),
        {"count": 10, "block": 1000},
    )


@pytest.mark.parametrize("empty", [None, []])
async def test_empty_poll_keeps_looping_until_data_arrives(empty: Any) -> None:
    client = _FakeRedis([empty, [("s", [("1-0", {"data": json.dumps(_envelope(7))})])]])
    got: list[Any] = []

    async def dispatch(raw: Any) -> None:
        got.append(raw)

    await asyncio.wait_for(_run(client, stream="s").run(dispatch), timeout=2)

    assert got == [_envelope(7)]
    assert len(client.read_calls) == 3  # empty poll, data poll, stop poll


async def test_busygroup_error_is_tolerated() -> None:
    client = _FakeRedis([], group_error=RuntimeError("BUSYGROUP Consumer Group already exists"))

    async def dispatch(raw: Any) -> None:
        return None

    await asyncio.wait_for(_run(client).run(dispatch), timeout=2)

    assert len(client.read_calls) == 1  # went on to read despite the re-create error


async def test_other_group_error_propagates_before_reading() -> None:
    client = _FakeRedis([], group_error=ConnectionError("redis unreachable"))

    async def dispatch(raw: Any) -> None:
        return None

    with pytest.raises(ConnectionError, match="redis unreachable"):
        await _run(client).run(dispatch)

    assert client.read_calls == []


async def test_unparseable_entries_are_acked_and_skipped(caplog: pytest.LogCaptureFixture) -> None:
    client = _FakeRedis(
        [
            [
                (
                    "s",
                    [
                        ("1-0", {"other": "x"}),  # missing data field
                        ("2-0", {"data": "{not json"}),  # invalid JSON
                        ("3-0", {"data": json.dumps(_envelope(3))}),
                    ],
                )
            ]
        ]
    )
    got: list[Any] = []

    async def dispatch(raw: Any) -> None:
        got.append(raw)

    with caplog.at_level(logging.ERROR, logger="server_decorator.consumer"):
        await asyncio.wait_for(_run(client, stream="s", group="g").run(dispatch), timeout=2)

    assert got == [_envelope(3)]  # poison entries never reach the handler
    assert [a[2] for a in client.acked] == ["1-0", "2-0", "3-0"]
    skipped = [r.getMessage() for r in caplog.records if "acking + skipping" in r.getMessage()]
    assert len(skipped) == 2
    assert "1-0" in skipped[0] and "2-0" in skipped[1]


async def test_handler_failure_leaves_entry_pending_and_continues(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = _FakeRedis(
        [
            [
                (
                    "s",
                    [
                        ("1-0", {"data": json.dumps(_envelope(1))}),
                        ("2-0", {"data": json.dumps(_envelope(2))}),
                    ],
                )
            ]
        ]
    )
    got: list[Any] = []

    async def dispatch(raw: Any) -> None:
        if raw["payload"] == 1:
            raise RuntimeError("handler boom")
        got.append(raw)

    with caplog.at_level(logging.ERROR, logger="server_decorator.consumer"):
        await asyncio.wait_for(_run(client, stream="s", group="g").run(dispatch), timeout=2)

    assert got == [_envelope(2)]  # one poison message does not halt the pipe
    assert client.acked == [("s", "g", "2-0")]  # 1-0 stays pending for redelivery
    assert any("left pending" in r.getMessage() and "1-0" in r.getMessage() for r in caplog.records)


async def test_stop_before_run_exits_without_reading() -> None:
    client = _FakeRedis([[("s", [("1-0", {"data": json.dumps(_envelope(1))})])]])
    consumer = _run(client)
    await consumer.stop()

    async def dispatch(raw: Any) -> None:
        raise AssertionError("must not dispatch after stop")

    await asyncio.wait_for(consumer.run(dispatch), timeout=2)

    assert len(client.group_calls) == 1
    assert client.read_calls == []
    assert client.acked == []

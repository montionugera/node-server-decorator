"""Unit coverage for RedisStreamAdapter using a fake redis client (no real Redis)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server_decorator.queue.adapters.redis_adapter import RedisStreamAdapter
from server_decorator.queue.message import QueueMessage


class _FakeRedis:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._error = error

    async def xadd(self, stream: str, fields: dict[str, Any]) -> str:
        if self._error is not None:
            raise self._error
        self.calls.append((stream, fields))
        return "1-0"


def _message(payload: Any = None) -> QueueMessage:
    return {
        "eventName": "User.created",
        "payload": payload,
        "timestamp": 1700000000000,
        "metadata": {"className": "User", "methodName": "created", "topic": None},
    }


async def test_publish_xadds_compact_json_to_named_stream() -> None:
    client = _FakeRedis()
    msg = _message({"id": 1, "tags": ["a", "b"]})

    await RedisStreamAdapter(client, stream="orders").publish(msg)

    assert len(client.calls) == 1
    stream, fields = client.calls[0]
    assert stream == "orders"
    assert list(fields) == ["data"]
    # Compact separators: the wire body carries no insignificant whitespace.
    assert fields["data"] == json.dumps(msg, separators=(",", ":"))
    assert ", " not in fields["data"] and ": " not in fields["data"]
    assert json.loads(fields["data"]) == msg


async def test_publish_defaults_to_the_default_stream() -> None:
    client = _FakeRedis()

    await RedisStreamAdapter(client).publish(_message())

    assert client.calls[0][0] == "default"
    assert json.loads(client.calls[0][1]["data"])["payload"] is None


@pytest.mark.parametrize("payload", [0, "", False, [], {}])
async def test_publish_preserves_falsy_payloads(payload: Any) -> None:
    client = _FakeRedis()

    await RedisStreamAdapter(client, stream="s").publish(_message(payload))

    decoded = json.loads(client.calls[0][1]["data"])
    assert decoded["payload"] == payload
    assert type(decoded["payload"]) is type(payload)


async def test_publish_each_message_is_one_xadd_in_order() -> None:
    client = _FakeRedis()
    adapter = RedisStreamAdapter(client, stream="s")

    for i in range(3):
        await adapter.publish(_message(i))

    assert [json.loads(f["data"])["payload"] for _, f in client.calls] == [0, 1, 2]


async def test_publish_propagates_client_errors() -> None:
    adapter = RedisStreamAdapter(_FakeRedis(ConnectionError("redis down")), stream="s")

    with pytest.raises(ConnectionError, match="redis down"):
        await adapter.publish(_message())


async def test_publish_rejects_non_json_payload_before_touching_redis() -> None:
    client = _FakeRedis()

    with pytest.raises(TypeError):
        await RedisStreamAdapter(client).publish(_message(object()))

    assert client.calls == []

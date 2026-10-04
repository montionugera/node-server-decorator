"""Unit tests for RabbitMQAdapter with a fake aio-pika channel (no broker)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server_decorator.queue.adapters.rabbitmq_adapter import RabbitMQAdapter
from server_decorator.queue.message import QueueMessage


class _FakeExchange:
    def __init__(self, name: str) -> None:
        self.name = name
        self.published: list[tuple[Any, str]] = []

    async def publish(self, message: Any, *, routing_key: str) -> None:
        self.published.append((message, routing_key))


class _FakeChannel:
    def __init__(self) -> None:
        self.default_exchange = _FakeExchange("")
        self.exchanges: dict[str, _FakeExchange] = {}
        self.requested: list[str] = []

    async def get_exchange(self, name: str) -> _FakeExchange:
        self.requested.append(name)
        return self.exchanges.setdefault(name, _FakeExchange(name))


def _msg(metadata: Any = None) -> QueueMessage:
    msg: dict[str, Any] = {"eventName": "Svc.go", "payload": {"a": 1, "b": "é"}, "timestamp": 5}
    if metadata is not None:
        msg["metadata"] = metadata
    return msg  # type: ignore[return-value]


async def test_queue_mode_publishes_to_default_exchange_with_queue_routing_key() -> None:
    channel = _FakeChannel()
    adapter = RabbitMQAdapter(channel, "orders")

    message = _msg({"topic": "ignored.in.queue.mode"})
    await adapter.publish(message)

    assert channel.requested == []
    [(amqp, routing_key)] = channel.default_exchange.published
    assert routing_key == "orders"
    assert amqp.content_type == "application/json"
    # Compact separators, and the body round-trips to the original envelope.
    assert amqp.body == json.dumps(message, separators=(",", ":")).encode("utf-8")
    assert b", " not in amqp.body and b": " not in amqp.body
    assert json.loads(amqp.body) == message


async def test_exchange_mode_routes_by_metadata_topic() -> None:
    channel = _FakeChannel()
    adapter = RabbitMQAdapter(channel, "events", exchange=True)

    await adapter.publish(_msg({"topic": "Svc.go"}))

    assert channel.requested == ["events"]
    assert channel.default_exchange.published == []
    [(amqp, routing_key)] = channel.exchanges["events"].published
    assert routing_key == "Svc.go"
    assert json.loads(amqp.body)["metadata"] == {"topic": "Svc.go"}


@pytest.mark.parametrize(
    "metadata",
    [
        None,  # no metadata key at all
        {},  # metadata without topic
        {"topic": None},
        {"topic": 42},  # non-string topic never becomes a routing key
    ],
)
async def test_exchange_mode_falls_back_to_default_routing_key(metadata: Any) -> None:
    channel = _FakeChannel()
    adapter = RabbitMQAdapter(channel, "events", exchange=True)

    await adapter.publish(_msg(metadata))

    [(_, routing_key)] = channel.exchanges["events"].published
    assert routing_key == "default"


async def test_publish_propagates_broker_errors() -> None:
    class _Boom(_FakeChannel):
        async def get_exchange(self, name: str) -> _FakeExchange:
            raise ConnectionError("channel closed")

    adapter = RabbitMQAdapter(_Boom(), "events", exchange=True)
    with pytest.raises(ConnectionError, match="channel closed"):
        await adapter.publish(_msg({"topic": "t"}))

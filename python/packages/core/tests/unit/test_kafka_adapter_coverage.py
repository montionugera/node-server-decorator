"""Unit coverage for KafkaAdapter using a duck-typed fake producer (no aiokafka, no broker)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server_decorator.queue.adapters.kafka_adapter import KafkaAdapter


class _FakeProducer:
    def __init__(self, fail_with: Exception | None = None) -> None:
        self.sent: list[tuple[str, bytes, bytes | None]] = []
        self._fail_with = fail_with

    async def send_and_wait(self, topic: str, value: bytes, key: bytes | None = None) -> None:
        if self._fail_with is not None:
            raise self._fail_with
        self.sent.append((topic, value, key))


def _msg(**extra: Any) -> Any:
    return {"eventName": "User.created", "payload": {"id": 1}, "timestamp": 5, **extra}


async def test_publish_uses_metadata_topic_and_event_name_key() -> None:
    producer = _FakeProducer()
    message = _msg(metadata={"topic": "users", "service": "svc"})

    await KafkaAdapter(producer).publish(message)

    assert len(producer.sent) == 1
    topic, body, key = producer.sent[0]
    assert topic == "users"
    assert key == b"User.created"
    assert json.loads(body) == message


async def test_publish_body_is_compact_utf8_json() -> None:
    producer = _FakeProducer()

    await KafkaAdapter(producer).publish(_msg(payload={"name": "ก"}))

    body = producer.sent[0][1]
    assert isinstance(body, bytes)
    # compact separators: no ", " / ": " padding on the wire
    assert body == json.dumps(_msg(payload={"name": "ก"}), separators=(",", ":")).encode("utf-8")
    assert b", " not in body and b'": ' not in body


@pytest.mark.parametrize(
    "metadata",
    [
        None,  # explicit null metadata
        {},  # no topic key
        {"topic": None},
        {"topic": ""},  # empty string is not a usable topic
        {"topic": 123},  # non-string topic is ignored
    ],
)
async def test_publish_falls_back_to_default_topic(metadata: Any) -> None:
    producer = _FakeProducer()

    await KafkaAdapter(producer, default_topic="fallback").publish(_msg(metadata=metadata))

    assert producer.sent[0][0] == "fallback"


async def test_publish_without_metadata_key_uses_builtin_default_topic() -> None:
    producer = _FakeProducer()

    await KafkaAdapter(producer).publish(_msg())

    assert producer.sent[0][0] == "default"


async def test_publish_propagates_producer_error() -> None:
    producer = _FakeProducer(fail_with=ConnectionError("broker down"))

    with pytest.raises(ConnectionError, match="broker down"):
        await KafkaAdapter(producer).publish(_msg())

    assert producer.sent == []


async def test_publish_rejects_message_without_event_name() -> None:
    producer = _FakeProducer()

    with pytest.raises(KeyError):
        await KafkaAdapter(producer).publish({"payload": 1, "timestamp": 1})  # type: ignore[typeddict-item]

    assert producer.sent == []

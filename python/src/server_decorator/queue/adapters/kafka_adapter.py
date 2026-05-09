"""Kafka adapter (aiokafka). Topic comes from the message metadata.

The producer is typed `Any` to avoid pulling aiokafka's untyped surface into
the strict-mypy boundary. The runtime expectation is `aiokafka.AIOKafkaProducer`
or any duck-typed equivalent with `send_and_wait(topic, value, key=...)`.
"""

from __future__ import annotations

import json
from typing import Any

from server_decorator.queue.message import QueueMessage


class KafkaAdapter:
    def __init__(self, producer: Any, default_topic: str = "default") -> None:
        self._producer = producer
        self._default_topic = default_topic

    async def publish(self, message: QueueMessage) -> None:
        body = json.dumps(message, separators=(",", ":")).encode("utf-8")
        topic_raw = (message.get("metadata") or {}).get("topic")
        topic = topic_raw if isinstance(topic_raw, str) and topic_raw else self._default_topic
        key = message["eventName"].encode("utf-8")
        await self._producer.send_and_wait(topic, body, key=key)

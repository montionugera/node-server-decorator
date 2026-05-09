"""Kafka adapter (aiokafka). Topic comes from the message metadata."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from server_decorator.queue.message import QueueMessage

if TYPE_CHECKING:
    from aiokafka import AIOKafkaProducer


class KafkaAdapter:
    def __init__(self, producer: AIOKafkaProducer, default_topic: str = "default") -> None:
        self._producer = producer
        self._default_topic = default_topic

    async def publish(self, message: QueueMessage) -> None:
        body = json.dumps(message, separators=(",", ":")).encode("utf-8")
        topic_raw = (message.get("metadata") or {}).get("topic")  # type: ignore[union-attr]
        topic = topic_raw if isinstance(topic_raw, str) and topic_raw else self._default_topic
        key = message["eventName"].encode("utf-8")
        await self._producer.send_and_wait(topic, body, key=key)

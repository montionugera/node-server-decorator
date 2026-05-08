"""In-memory queue adapter for unit tests."""

from __future__ import annotations

from typing import Any

from server_decorator.queue.message import QueueMessage


class InMemoryQueueAdapter:
    def __init__(self) -> None:
        self.messages: dict[str, list[QueueMessage]] = {}

    async def publish(self, message: QueueMessage) -> None:
        topic_raw: Any = (message.get("metadata") or {}).get("topic")  # type: ignore[union-attr]
        topic = topic_raw if isinstance(topic_raw, str) and topic_raw else "default"
        self.messages.setdefault(topic, []).append(message)

    def clear(self) -> None:
        self.messages.clear()

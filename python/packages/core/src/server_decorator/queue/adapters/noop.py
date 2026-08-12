"""No-op queue adapter — drops every message. Useful as a safe default."""

from __future__ import annotations

from server_decorator.queue.message import QueueMessage


class NoOpQueueAdapter:
    async def publish(self, message: QueueMessage) -> None:
        return None

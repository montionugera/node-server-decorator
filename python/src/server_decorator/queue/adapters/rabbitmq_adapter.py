"""RabbitMQ adapter (aio-pika).

The channel is typed `Any` to avoid pulling aio-pika's untyped surface into the
strict-mypy boundary. Runtime expectation: `aio_pika.abc.AbstractChannel`.
"""

from __future__ import annotations

import json
from typing import Any

from server_decorator.queue.message import QueueMessage


class RabbitMQAdapter:
    def __init__(
        self,
        channel: Any,
        queue_or_exchange: str,
        *,
        exchange: bool = False,
    ) -> None:
        self._channel = channel
        self._target = queue_or_exchange
        self._is_exchange = exchange

    async def publish(self, message: QueueMessage) -> None:
        from aio_pika import Message

        body = json.dumps(message, separators=(",", ":")).encode("utf-8")
        amqp_message = Message(body=body, content_type="application/json")
        if self._is_exchange:
            exchange = await self._channel.get_exchange(self._target)
            topic_raw = (message.get("metadata") or {}).get("topic")
            routing_key = topic_raw if isinstance(topic_raw, str) else "default"
            await exchange.publish(amqp_message, routing_key=routing_key)
        else:
            await self._channel.default_exchange.publish(amqp_message, routing_key=self._target)

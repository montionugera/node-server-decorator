"""RabbitMQConsumer — at-least-once consume via aio-pika. The message body is the JSON
envelope (matching the producer's RabbitMQAdapter). dispatch success -> ack; dispatch
raise -> nack(requeue=True); unparseable body -> ack + drop (log). Consumes one queue."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class RabbitMQConsumer:
    def __init__(self, channel: Any, *, queue: str, prefetch: int = 10) -> None:
        self._channel = channel
        self._queue_name = queue
        self._prefetch = prefetch
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        await self._channel.set_qos(prefetch_count=self._prefetch)
        queue = await self._channel.declare_queue(self._queue_name, durable=True)
        async with queue.iterator() as it:
            async for message in it:
                if self._stop.is_set():
                    break
                try:
                    raw = json.loads(message.body)
                except Exception:
                    _log.exception("unparseable rabbitmq message; acking + dropping")
                    await message.ack()
                    continue
                try:
                    await dispatch(raw)
                except Exception:
                    _log.exception("dispatch failed for rabbitmq message; requeueing")
                    await message.nack(requeue=True)
                    continue
                await message.ack()

    async def stop(self) -> None:
        self._stop.set()

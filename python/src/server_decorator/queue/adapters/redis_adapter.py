"""Redis Streams adapter (XADD)."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from server_decorator.queue.message import QueueMessage

if TYPE_CHECKING:
    from redis.asyncio import Redis


class RedisStreamAdapter:
    def __init__(self, client: Redis, stream: str = "default") -> None:
        self._client = client
        self._stream = stream

    async def publish(self, message: QueueMessage) -> None:
        body = json.dumps(message, separators=(",", ":"))
        await self._client.xadd(self._stream, {"data": body})

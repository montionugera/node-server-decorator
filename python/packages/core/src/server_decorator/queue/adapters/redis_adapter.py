"""Redis Streams adapter (XADD).

The client is typed `Any` to avoid pulling redis-py's untyped surface into the
strict-mypy boundary. Runtime expectation: `redis.asyncio.Redis` or equivalent.
"""

from __future__ import annotations

import json
from typing import Any

from server_decorator.queue.message import QueueMessage


class RedisStreamAdapter:
    def __init__(self, client: Any, stream: str = "default") -> None:
        self._client = client
        self._stream = stream

    async def publish(self, message: QueueMessage) -> None:
        body = json.dumps(message, separators=(",", ":"))
        await self._client.xadd(self._stream, {"data": body})

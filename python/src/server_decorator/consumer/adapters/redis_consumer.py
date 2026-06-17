"""RedisStreamConsumer — at-least-once consume over a Redis stream using a consumer
group. Reads with XREADGROUP, dispatches the JSON in the ``data`` field (matching the
producer's RedisStreamAdapter), and XACKs only on successful dispatch. A handler that
raises leaves the entry pending → reclaimable (at-least-once)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ..adapter import Dispatch


class RedisStreamConsumer:
    def __init__(
        self,
        client: Any,
        *,
        stream: str = "default",
        group: str = "server-decorator",
        consumer_name: str = "consumer-1",
        block_ms: int = 1000,
        batch: int = 10,
    ) -> None:
        self._client = client
        self._stream = stream
        self._group = group
        self._name = consumer_name
        self._block_ms = block_ms
        self._batch = batch
        self._stop = asyncio.Event()

    async def _ensure_group(self) -> None:
        try:
            await self._client.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except Exception as err:  # redis raises a BUSYGROUP error string on re-create
            if "BUSYGROUP" not in str(err):
                raise

    async def run(self, dispatch: Dispatch) -> None:
        await self._ensure_group()
        while not self._stop.is_set():
            resp = await self._client.xreadgroup(
                self._group,
                self._name,
                {self._stream: ">"},
                count=self._batch,
                block=self._block_ms,
            )
            if not resp:
                continue
            for _stream_key, entries in resp:
                for entry_id, fields in entries:
                    data = fields.get(b"data") or fields.get("data")
                    raw = json.loads(data)
                    await dispatch(raw)  # raise here → skip XACK (stays pending)
                    await self._client.xack(self._stream, self._group, entry_id)

    async def stop(self) -> None:
        self._stop.set()

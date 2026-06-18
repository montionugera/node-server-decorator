"""RedisStreamConsumer — at-least-once consume over a Redis stream using a consumer
group. Reads with XREADGROUP, dispatches the JSON in the ``data`` field (matching the
producer's RedisStreamAdapter). Failures are handled in two phases (spec §5):

- Parse/validation failures (missing ``data`` field, or ``data`` that isn't valid JSON)
  are ACKed and skipped (with a log). Retrying never helps, and leaving them pending
  would grow the Redis PEL unboundedly.
- Genuine handler failures (a valid envelope whose dispatch raises) leave the entry
  PENDING (not ACKed) for later retry, while the consumer keeps processing subsequent
  messages so one poison message can't halt the pipe.

Automatic reclaim of pending entries via XAUTOCLAIM is a future enhancement (Plan 2);
today a handler-failed entry stays pending until an external reclaimer or a restart
picks it up."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


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
                    # Phase 1: parse. Malformed/absent-data can never succeed → ack + skip.
                    try:
                        if data is None:
                            raise ValueError("entry missing 'data' field")
                        raw = json.loads(data)
                    except Exception:
                        _log.exception("unparseable entry %s; acking + skipping", entry_id)
                        await self._client.xack(self._stream, self._group, entry_id)
                        continue
                    # Phase 2: dispatch. Handler failure → leave pending for retry.
                    try:
                        await dispatch(raw)
                    except Exception:
                        _log.exception("dispatch failed for entry %s; left pending", entry_id)
                        continue
                    await self._client.xack(self._stream, self._group, entry_id)

    async def stop(self) -> None:
        self._stop.set()

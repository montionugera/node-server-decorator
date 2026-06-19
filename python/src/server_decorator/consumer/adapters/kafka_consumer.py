"""KafkaConsumer — at-least-once consume via an aiokafka consumer group with manual
offset commit. Each record's value is the JSON envelope (matching the producer's
KafkaAdapter). dispatch success -> commit; dispatch raise -> do NOT commit (redelivered
on restart/rebalance); unparseable value -> commit + skip (log)."""

from __future__ import annotations

import asyncio
import json
import logging

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class KafkaConsumer:
    def __init__(
        self,
        bootstrap_servers: str,
        *,
        topics: list[str],
        group_id: str = "server-decorator",
        auto_offset_reset: str = "earliest",
    ) -> None:
        self._bootstrap = bootstrap_servers
        self._topics = topics
        self._group_id = group_id
        self._auto_offset_reset = auto_offset_reset
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        from aiokafka import AIOKafkaConsumer

        consumer = AIOKafkaConsumer(
            *self._topics,
            bootstrap_servers=self._bootstrap,
            group_id=self._group_id,
            enable_auto_commit=False,
            auto_offset_reset=self._auto_offset_reset,
        )
        await consumer.start()
        try:
            while not self._stop.is_set():
                batch = await consumer.getmany(timeout_ms=1000, max_records=10)
                for _tp, records in batch.items():
                    for record in records:
                        try:
                            raw = json.loads(record.value)
                        except Exception:
                            _log.exception("unparseable kafka record; committing + skipping")
                            await consumer.commit()
                            continue
                        try:
                            await dispatch(raw)
                        except Exception:
                            _log.exception("dispatch failed for kafka record; not committing")
                            continue
                        await consumer.commit()
        finally:
            await consumer.stop()

    async def stop(self) -> None:
        self._stop.set()

"""BullMQConsumer — consume BullMQ jobs via the official `bullmq` package's Worker. The
Node producer's BullMQAdapter stores the QueueMessage as the job's data, so ``job.data``
IS the envelope. dispatch success -> processor returns (job completed); dispatch raise ->
processor raises (BullMQ retries per the job's attempts). No parse phase: job.data is
already structured; an invalid envelope reaches dispatch's on_invalid path and the job
completes. Requires the `bullmq` extra (pip install server-decorator[bullmq])."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..adapter import Dispatch

_log = logging.getLogger("server_decorator.consumer")


class BullMQConsumer:
    def __init__(
        self,
        *,
        queue_name: str,
        connection: str,
        concurrency: int = 1,
    ) -> None:
        self._queue_name = queue_name
        self._connection = connection
        self._concurrency = concurrency
        self._worker: Any = None
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        from bullmq import Worker

        async def process(job: Any, job_token: str) -> None:
            await dispatch(job.data)

        self._worker = Worker(
            self._queue_name,
            process,
            {"connection": self._connection, "concurrency": self._concurrency},
        )
        await self._stop.wait()

    async def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            await self._worker.close()

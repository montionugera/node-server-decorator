"""In-memory consumer for unit tests — the dual of InMemoryQueueAdapter. Feed it raw
envelopes via ``feed`` (or construct with a list); ``run`` dispatches each one."""

from __future__ import annotations

import asyncio
from typing import Any

from .adapter import Dispatch


class InMemoryConsumer:
    def __init__(self, messages: list[Any] | None = None) -> None:
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._stop = asyncio.Event()
        for m in messages or []:
            self._queue.put_nowait(m)

    def feed(self, raw: Any) -> None:
        self._queue.put_nowait(raw)

    async def run(self, dispatch: Dispatch) -> None:
        while not self._stop.is_set():
            try:
                raw = await asyncio.wait_for(self._queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                continue
            await dispatch(raw)

    async def stop(self) -> None:
        self._stop.set()

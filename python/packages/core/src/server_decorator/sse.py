"""Server-Sent Events (SSE) transport engine.

Provides real-time SSE streaming, message framing, non-blocking client fan-out,
heartbeat pings, and Last-Event-ID event replay.
"""

from __future__ import annotations

import asyncio
import collections
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

T = TypeVar("T")


@dataclass
class SSEEvent(Generic[T]):
    """Represents a Server-Sent Event frame."""

    id: str | None = None
    event: str | None = None
    data: T = None  # type: ignore[assignment]
    timestamp: int | None = None

    def format(self) -> str:
        """Format event to standard SSE wire format: `id: ...\\nevent: ...\\ndata: ...\\n\\n`."""
        lines: list[str] = []
        if self.id is not None and self.id != "":
            lines.append(f"id: {self.id}")
        if self.event is not None and self.event != "":
            lines.append(f"event: {self.event}")
        data_str = self.data if isinstance(self.data, str) else json.dumps(self.data)
        lines.append(f"data: {data_str}")
        return "\n".join(lines) + "\n\n"


def format_sse_message(event: SSEEvent[Any]) -> str:
    """Format an SSEEvent into its wire string representation."""
    return event.format()


class AsyncSSEBroadcaster(Generic[T]):
    """Coordinates SSE event fan-out, client subscriptions, and keep-alive pings."""

    def __init__(
        self,
        heartbeat_seconds: float = 15.0,
        history_limit: int = 100,
        buffer_size: int = 256,
    ) -> None:
        self.heartbeat_seconds = heartbeat_seconds
        self.history_limit = max(0, history_limit)
        self.buffer_size = max(1, buffer_size)
        self._subscribers: set[asyncio.Queue[str | None]] = set()
        self._history: collections.deque[SSEEvent[T]] = collections.deque(
            maxlen=self.history_limit if self.history_limit > 0 else None
        )
        self._closed = False

    @property
    def subscriber_count(self) -> int:
        """Return the count of currently active subscriber queues."""
        return len(self._subscribers)

    @property
    def history(self) -> list[SSEEvent[T]]:
        """Return a snapshot list of cached events in the ring buffer."""
        return list(self._history)

    async def broadcast(self, event: SSEEvent[T]) -> None:
        """Broadcast an event to all active subscriber queues."""
        if self._closed:
            return

        if event.timestamp is None:
            event.timestamp = int(time.time() * 1000)

        if event.id is not None:
            self._history.append(event)

        frame = event.format()
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                # Drop/ignore to prevent slow or stalled consumers from blocking broadcaster
                pass

    async def publish(self, event: SSEEvent[T]) -> None:
        """Alias for broadcast."""
        await self.broadcast(event)

    def subscribe(self, last_event_id: str | None = None) -> AsyncIterator[str]:
        """Subscribe to SSE events as an async generator.

        Replays cached events occurring after `last_event_id` if present, then
        streams live events with periodic keep-alive pings.
        """
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=self.buffer_size)
        # Snapshot the replay in the same synchronous step that registers the queue,
        # so no event is both replayed and delivered live. Replay is positional:
        # events after last_event_id's position in the history, or the whole
        # history when it is not (or no longer) in the buffer.
        replayed: list[SSEEvent[T]] = []
        if not self._closed:
            self._subscribers.add(queue)
            if last_event_id is not None:
                history = list(self._history)
                start = 0
                for i, e in enumerate(history):
                    if e.id == last_event_id:
                        start = i + 1
                        break
                replayed = history[start:]

        async def _generator() -> AsyncIterator[str]:
            if self._closed:
                return

            try:
                for item in replayed:
                    yield item.format()

                # Main live event streaming loop
                while not self._closed:
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=self.heartbeat_seconds)
                        if msg is None:
                            break
                        yield msg
                    except (TimeoutError, asyncio.TimeoutError):
                        yield ": ping\n\n"
            finally:
                self._subscribers.discard(queue)

        return _generator()

    async def close(self) -> None:
        """Close broadcaster and notify all active subscribers."""
        self._closed = True
        for q in list(self._subscribers):
            try:
                q.put_nowait(None)
            except (asyncio.QueueFull, Exception):
                pass
        self._subscribers.clear()

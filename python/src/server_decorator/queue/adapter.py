"""QueueAdapter Protocol + the global single-queue helpers (mirror Node's `globalQueue`)."""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Protocol

from server_decorator.queue.message import QueueMessage


class QueueAdapter(Protocol):
    async def publish(self, message: QueueMessage) -> None: ...


global_queue: QueueAdapter | None = None


def set_global_queue(adapter: QueueAdapter) -> None:
    global global_queue
    global_queue = adapter


def has_global_queue() -> bool:
    return global_queue is not None


__all__ = ["QueueAdapter", "global_queue", "set_global_queue", "has_global_queue"]


# Awaitable is imported only to keep the type stub importable in editor tooling
_ = Awaitable

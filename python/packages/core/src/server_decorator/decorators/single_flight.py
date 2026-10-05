"""Keyed single-flight for asyncio: concurrent callers of one key share one execution.

Nothing is cached. The key is forgotten as soon as the work finishes, so a later call runs the
work again. In-process only, and one instance belongs to one event loop.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Hashable
from typing import Generic, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


class _Flight(Generic[V]):
    """One in-flight execution: its task and the number of callers awaiting it."""

    __slots__ = ("task", "waiters")

    task: asyncio.Task[V]

    def __init__(self) -> None:
        self.waiters = 0


class SingleFlight(Generic[K, V]):
    """Keyed single-flight for asyncio: one execution per key while it is in flight."""

    def __init__(self) -> None:
        self._flights: dict[K, _Flight[V]] = {}

    async def do(self, key: K, fn: Callable[[], Awaitable[V]]) -> V:
        """Run fn once per key. Callers that arrive while it runs share its outcome.

        The work runs in its own task. Cancelling a caller cancels only that caller; the work
        keeps running while another caller waits and is cancelled when the last one leaves.
        """
        # No await between the lookup and the registration: two callers cannot both start work.
        flight = self._flights.get(key)
        if flight is None:
            flight = _Flight()
            self._flights[key] = flight
            flight.task = asyncio.create_task(self._run(key, flight, fn))
            flight.task.add_done_callback(_consume_exception)
        flight.waiters += 1
        try:
            # wait() keeps this caller's cancellation away from the shared task. It is used
            # instead of shield(), which reports the task's exception to the loop exception
            # handler (Python 3.14) when the shielding caller was cancelled.
            await asyncio.wait((flight.task,))
            return flight.task.result()
        finally:
            flight.waiters -= 1
            if flight.waiters == 0 and not flight.task.done():
                # The last waiting caller was cancelled: nobody wants the result any more.
                self._forget(key, flight)
                flight.task.cancel()

    def clear(self) -> None:
        """Forget every in-flight key. Running work continues while callers wait."""
        self._flights.clear()

    def __len__(self) -> int:
        """Number of keys currently in flight."""
        return len(self._flights)

    async def _run(self, key: K, flight: _Flight[V], fn: Callable[[], Awaitable[V]]) -> V:
        try:
            return await fn()
        finally:
            # Inside the task, so the key is gone before any caller resumes.
            self._forget(key, flight)

    def _forget(self, key: K, flight: _Flight[V]) -> None:
        # Identity check: work that was cleared or cancelled must not remove a newer entry.
        if self._flights.get(key) is flight:
            del self._flights[key]


def _consume_exception(task: asyncio.Task[V]) -> None:
    # Marks the exception as retrieved, so asyncio does not log "Task exception was never
    # retrieved" when every caller left before the work failed.
    if not task.cancelled():
        task.exception()

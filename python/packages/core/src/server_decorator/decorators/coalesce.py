"""@batch_load decorator for transparent async call coalescing and batch loading.

Collects concurrent individual lookups within a micro-tick or time window and dispatches
them as a single bulk operation, eliminating N+1 round trips and avoiding DB saturation.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import inspect
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar, cast

from server_decorator.decorators._class_apply import _mark_wrapped

F = TypeVar("F", bound=Callable[..., Any])
K = TypeVar("K")
V = TypeVar("V")


class QueuedItem(Generic[K, V]):
    __slots__ = ("future", "key")

    def __init__(self, key: K, future: asyncio.Future[V]) -> None:
        self.future = future
        self.key = key


class BatchQueue(Generic[K, V]):
    def __init__(
        self,
        loader_fn: Callable[[list[K]], Awaitable[Any]],
        max_batch_size: int = 100,
        window_seconds: float = 0.001,
        deduplicate: bool = True,
        key_of: Callable[[Any], K] | None = None,
    ) -> None:
        self.loader_fn = loader_fn
        self.max_batch_size = max_batch_size
        self.window_seconds = window_seconds
        self.deduplicate = deduplicate
        self.key_of = key_of
        self.queue: list[QueuedItem[K, V]] = []
        self.scheduled_handle: asyncio.TimerHandle | asyncio.Handle | None = None
        self.in_flight: dict[K, asyncio.Future[V]] = {}
        self._background_tasks: set[asyncio.Task[Any]] = set()

    def _spawn_task(self, coro: Awaitable[Any]) -> None:
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def load(self, key: K) -> asyncio.Future[V]:
        loop = asyncio.get_running_loop()

        if self.deduplicate and key in self.in_flight:
            return self.in_flight[key]

        fut: asyncio.Future[V] = loop.create_future()
        self.queue.append(QueuedItem(key, fut))

        if self.deduplicate:
            self.in_flight[key] = fut

            def _clean(_: Any) -> None:
                self.in_flight.pop(key, None)

            fut.add_done_callback(_clean)

        if len(self.queue) >= self.max_batch_size:
            batch = self.queue[: self.max_batch_size]
            self.queue = self.queue[self.max_batch_size :]
            if not self.queue and self.scheduled_handle:
                self.scheduled_handle.cancel()
                self.scheduled_handle = None
            self._spawn_task(self._dispatch_batch(batch))
        elif self.scheduled_handle is None:
            self._schedule_dispatch(loop)

        return fut

    def _schedule_dispatch(self, loop: asyncio.AbstractEventLoop) -> None:
        if self.window_seconds > 0:
            self.scheduled_handle = loop.call_later(
                self.window_seconds, lambda: self._spawn_task(self._dispatch_timer())
            )
        else:
            self.scheduled_handle = loop.call_soon(lambda: self._spawn_task(self._dispatch_timer()))

    async def _dispatch_timer(self) -> None:
        self.scheduled_handle = None
        if not self.queue:
            return

        batch = self.queue
        self.queue = []
        await self._dispatch_batch(batch)

    async def _dispatch_batch(self, batch: list[QueuedItem[K, V]]) -> None:
        if not batch:
            return

        # Deduplicate keys while preserving order
        unique_keys: list[K] = []
        seen: set[Any] = set()
        for item in batch:
            if item.key not in seen:
                seen.add(item.key)
                unique_keys.append(item.key)

        try:
            raw_result = await self.loader_fn(unique_keys)
            result_map = self._normalize_result(raw_result)

            for item in batch:
                if not item.future.done():
                    item.future.set_result(result_map.get(item.key))
        except Exception as exc:
            for item in batch:
                if not item.future.done():
                    item.future.set_exception(exc)

    def _normalize_result(self, raw: Any) -> dict[Any, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, (list, tuple, set)):
            res: dict[Any, Any] = {}
            for elem in raw:
                if elem is not None:
                    if self.key_of is not None:
                        k = self.key_of(elem)
                    elif hasattr(elem, "id"):
                        k = elem.id
                    elif hasattr(elem, "key"):
                        k = elem.key
                    elif isinstance(elem, dict) and "id" in elem:
                        k = elem["id"]
                    elif isinstance(elem, dict) and "key" in elem:
                        k = elem["key"]
                    else:
                        continue
                    res[k] = elem
            return res
        return {}


def batch_load(
    batch_fn: Callable[[list[Any]], Awaitable[Any]] | None = None,
    *,
    batch_method: str | None = None,
    max_batch_size: int = 100,
    window_seconds: float = 0.001,
    deduplicate: bool = True,
    key_of: Callable[[Any], Any] | None = None,
    context_var: contextvars.ContextVar[Any] | None = None,
) -> Callable[[F], F]:
    """Decorator that coalesces individual async calls into a single batch call."""

    def decorator(fn: F) -> F:
        if not inspect.iscoroutinefunction(fn):
            raise TypeError(f"@batch_load requires an async coroutine function, got {fn}")

        queues_by_scope: dict[Any, BatchQueue[Any, Any]] = {}

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            # Determine scope and key
            prims = (str, int, float, bool, list, tuple, dict)
            is_prim = isinstance(args[0], prims) if args else True
            has_self = bool(args) and not is_prim
            instance = args[0] if has_self else None

            if has_self:
                key = args[1] if len(args) > 1 else kwargs.get("id", kwargs.get("key"))
            else:
                key = args[0] if args else kwargs.get("id", kwargs.get("key"))

            # Determine loader function
            resolved_batch_fn = batch_fn
            if resolved_batch_fn is None and batch_method and instance is not None:
                method = getattr(instance, batch_method, None)
                if callable(method):
                    resolved_batch_fn = method

            if resolved_batch_fn is None:
                return await fn(*args, **kwargs)

            # Determine scope key
            scope_target: Any = None
            if context_var is not None:
                try:
                    scope_target = context_var.get()
                except LookupError:
                    scope_target = None
            if scope_target is None:
                scope_target = instance if instance is not None else fn

            queue = queues_by_scope.get(scope_target)
            if queue is None:
                queue = BatchQueue(
                    resolved_batch_fn,
                    max_batch_size=max_batch_size,
                    window_seconds=window_seconds,
                    deduplicate=deduplicate,
                    key_of=key_of,
                )
                queues_by_scope[scope_target] = queue

            return await queue.load(key)

        _mark_wrapped(async_wrapper, "batch_load")
        return cast(F, async_wrapper)

    return decorator

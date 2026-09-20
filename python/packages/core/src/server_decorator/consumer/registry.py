"""ConsumerRegistry — the consume-side dual of QueueRegistry. Holds named consumers,
routes inbound messages to handlers by eventName, and owns the start/stop lifecycle.

Delivery contract: a handler that returns normally => the message is acked by the
adapter. A handler that raises => dispatch re-raises => the adapter does not ack =>
backend-native redelivery (at-least-once). Handlers MUST be idempotent."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .adapter import ConsumerAdapter, Dispatch
from .validate import InvalidEnvelope, validate_envelope

_log = logging.getLogger("server_decorator.consumer")

Handler = Callable[[Any, dict[str, Any]], Any]  # (payload, metadata) -> None | Awaitable
UnhandledHook = Callable[[str, Any], None]
InvalidHook = Callable[[Any, Exception], None]


def _on_task_done(task: asyncio.Task[None]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        _log.error("consumer task terminated with exception", exc_info=exc)


@dataclass
class _ConsumerEntry:
    adapter: ConsumerAdapter
    handlers: dict[str, Handler] = field(default_factory=dict)
    on_unhandled: UnhandledHook | None = None
    on_invalid: InvalidHook | None = None


class ConsumerRegistry:
    def __init__(self) -> None:
        self._consumers: dict[str, _ConsumerEntry] = {}
        self._default: str | None = None
        self._tasks: list[asyncio.Task[None]] = []

    def register(
        self,
        name: str,
        adapter: ConsumerAdapter,
        *,
        on_unhandled: UnhandledHook | None = None,
        on_invalid: InvalidHook | None = None,
    ) -> None:
        self._consumers[name] = _ConsumerEntry(
            adapter=adapter, on_unhandled=on_unhandled, on_invalid=on_invalid
        )
        if self._default is None:
            self._default = name

    def set_default(self, name: str) -> None:
        if name not in self._consumers:
            raise KeyError(name)
        self._default = name

    def on(self, event_name: str, handler: Handler, *, consumer: str | None = None) -> None:
        entry = self._entry(consumer)
        entry.handlers[event_name] = handler

    def clear(self) -> None:
        """Drop all consumers and handlers. Call stop() first if started — clear()
        does not cancel running tasks."""
        self._consumers.clear()
        self._default = None
        self._tasks.clear()

    async def start(self) -> None:
        for name, entry in self._consumers.items():
            dispatch = self._dispatch_for(name)
            task = asyncio.create_task(entry.adapter.run(dispatch))
            task.add_done_callback(_on_task_done)
            self._tasks.append(task)

    async def stop(self) -> None:
        for entry in self._consumers.values():
            await entry.adapter.stop()
        for task in self._tasks:
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()

    def _entry(self, consumer: str | None) -> _ConsumerEntry:
        name = consumer or self._default
        if name is None or name not in self._consumers:
            raise KeyError(f"consumer {consumer!r} not registered")
        return self._consumers[name]

    def _dispatch_for(self, name: str) -> Dispatch:
        entry = self._consumers[name]

        async def dispatch(raw: Any) -> None:
            try:
                event_name, payload, metadata = validate_envelope(raw)
            except InvalidEnvelope as err:
                if entry.on_invalid:
                    entry.on_invalid(raw, err)
                else:
                    _log.warning("invalid envelope dropped: %s", err)
                return  # acked + skipped
            handler = entry.handlers.get(event_name)
            if handler is None:
                if entry.on_unhandled:
                    entry.on_unhandled(event_name, raw)
                else:
                    _log.debug("no handler for event %s; acked + skipped", event_name)
                return  # acked + skipped
            traceparent = metadata.get("traceparent") if isinstance(metadata, dict) else None
            from server_decorator.decorators.trace import (
                TraceContext,
                parse_traceparent,
                set_active_trace_context,
            )

            token = None
            if traceparent:
                parsed_ctx = parse_traceparent(traceparent)
                if parsed_ctx:
                    tracestate = metadata.get("tracestate") if isinstance(metadata, dict) else None
                    consumer_ctx = TraceContext(
                        trace_id=parsed_ctx.trace_id,
                        span_id=parsed_ctx.span_id,
                        parent_span_id=parsed_ctx.span_id,
                        sampled=parsed_ctx.sampled,
                        tracestate=tracestate,
                    )
                    token = set_active_trace_context(consumer_ctx)

            try:
                result = handler(payload, metadata)
                if inspect.isawaitable(result):
                    await result  # a raise here propagates → adapter does not ack
            finally:
                if token is not None:
                    set_active_trace_context(None)

        return dispatch


global_consumer_registry = ConsumerRegistry()

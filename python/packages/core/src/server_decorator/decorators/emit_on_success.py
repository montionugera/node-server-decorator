"""@emit_on_success decorator (method form) + emit_on_success_class. Decisions #7 + D-C.

When `use_queue=True` is set on a sync method called outside an event loop, the side
effect runs on a single-worker `_EMIT_EXECUTOR` so the caller doesn't block (D-C).
That one worker thread runs every publish on one long-lived event loop (`_EMIT_LOOP`),
so loop-bound queue clients stay usable across messages.

Shutdown needs nothing from the caller: `concurrent.futures` joins the worker at
interpreter exit, which drains the emits already submitted, and an `atexit` hook
(`_close_emit_loop`) then closes the loop. Call `_EMIT_EXECUTOR.shutdown(wait=True)`
only to flush earlier than interpreter exit.
"""

from __future__ import annotations

import asyncio
import atexit
import concurrent.futures
import contextvars
import functools
import inspect
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

from server_decorator import emitter as _emitter_mod
from server_decorator import logger as _logger_mod
from server_decorator.config import get_service
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname
from server_decorator.queue import registry as _registry_mod
from server_decorator.queue.message import QueueMessage, QueueMessageMetadata

F = TypeVar("F", bound=Callable[..., Any])

# D-C: single-worker executor for sync-method fire-and-forget. I/O-bound and
# ordering matters, so one worker is fine. Drained on shutdown via atexit.
_EMIT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="server-decorator-emit"
)

# Strong references to in-flight create_task() futures so the GC doesn't drop them
# mid-flight (RUF006). Tasks self-remove via add_done_callback.
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()

# One long-lived event loop for the executor's single worker thread. asyncio.run()
# would create and close a loop per message, breaking loop-bound queue clients
# (redis.asyncio, aio-pika, aiokafka) after the first publish. Only ever touched
# from the worker thread, so no lock is needed.
_EMIT_LOOP: asyncio.AbstractEventLoop | None = None


def _run_on_emit_loop(coro: Coroutine[Any, Any, None]) -> None:
    global _EMIT_LOOP
    if _EMIT_LOOP is None or _EMIT_LOOP.is_closed():
        _EMIT_LOOP = asyncio.new_event_loop()
    _EMIT_LOOP.run_until_complete(coro)


def _close_emit_loop() -> None:
    # atexit handlers run after concurrent.futures has joined the worker thread,
    # so the loop is idle here.
    if _EMIT_LOOP is not None and not _EMIT_LOOP.is_running() and not _EMIT_LOOP.is_closed():
        _EMIT_LOOP.close()


atexit.register(_close_emit_loop)


@dataclass
class EmitOnSuccessOptions:
    transform: Callable[[Any], Any] | None = None
    use_events: bool = True
    use_queue: bool = False
    queue: str | None = None
    topic: str | None = None
    queue_metadata: dict[str, Any] = field(default_factory=dict)
    event_name: str | None = None


def emit_on_success(
    *,
    transform: Callable[[Any], Any] | None = None,
    use_events: bool = True,
    use_queue: bool = False,
    queue: str | None = None,
    topic: str | None = None,
    queue_metadata: dict[str, Any] | None = None,
    event_name: str | None = None,
) -> Callable[[F], F]:
    opts = EmitOnSuccessOptions(
        transform=transform,
        use_events=use_events,
        use_queue=use_queue,
        queue=queue,
        topic=topic,
        queue_metadata=queue_metadata or {},
        event_name=event_name,
    )

    def decorator(fn: F) -> F:
        qualname = shorten_qualname(fn.__qualname__)
        class_name, _, method_name = qualname.rpartition(".")
        resolved_event = opts.event_name or qualname

        async def _on_success(result: Any) -> None:
            # The method already succeeded: a raising transform must not change its
            # outcome. Log and skip emission instead of raising into the caller.
            try:
                payload = opts.transform(result) if opts.transform else result
            except Exception as e:
                _logger_mod.global_logger.error(
                    f"emit_on_success transform failed for {resolved_event}; nothing emitted: {e!r}"
                )
                return
            if opts.use_events:
                try:
                    _emitter_mod.global_emitter.emit(resolved_event, payload)
                except Exception as e:
                    _logger_mod.global_logger.error(f"Failed to emit event {resolved_event}: {e!r}")
            if opts.use_queue:
                try:
                    service = get_service()
                    # topic-naming.md: the auto topic is ClassName.methodName, never
                    # the event_name override (Node parity).
                    auto_topic = qualname
                    if service and opts.topic is None:
                        auto_topic = f"{service}.{qualname}"
                    meta: dict[str, Any] = {
                        "className": class_name,
                        "methodName": method_name,
                        "topic": opts.topic,
                        **({"service": service} if service else {}),
                        **opts.queue_metadata,
                    }
                    from server_decorator.decorators.trace import (
                        format_traceparent,
                        get_active_trace_context,
                    )

                    active_trace = get_active_trace_context()
                    if active_trace:
                        meta["traceparent"] = format_traceparent(
                            active_trace.trace_id, active_trace.span_id, active_trace.sampled
                        )
                        if active_trace.tracestate:
                            meta["tracestate"] = active_trace.tracestate

                    msg: QueueMessage = {
                        "eventName": resolved_event,
                        "payload": payload,
                        "timestamp": int(time.time() * 1000),
                        "metadata": cast(QueueMessageMetadata, meta),
                    }
                    if opts.queue or opts.topic or service:
                        await _registry_mod.global_queue_registry.publish(
                            msg, opts.queue, opts.topic or auto_topic
                        )
                    else:
                        await _registry_mod.global_queue_registry.publish(msg)
                except Exception as e:
                    _logger_mod.global_logger.error(f"Failed to publish to queue: {e!r}")

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                result = await fn(*args, **kwargs)
                await _on_success(result)
                return result

            _mark_wrapped(async_wrapper, "emit_on_success")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            result = fn(*args, **kwargs)
            try:
                loop = asyncio.get_running_loop()
                # Tracked in _BACKGROUND_TASKS to keep a strong reference (RUF006).
                task = loop.create_task(_on_success(result))
                _BACKGROUND_TASKS.add(task)
                task.add_done_callback(_BACKGROUND_TASKS.discard)
            except RuntimeError:
                # D-C: no running loop — submit to executor so caller doesn't block.
                # Run inside a copy of the caller's context: the worker thread's own
                # context is empty, which would drop the active trace (traceparent).
                _EMIT_EXECUTOR.submit(
                    contextvars.copy_context().run, _run_on_emit_loop, _on_success(result)
                )
            return result

        _mark_wrapped(sync_wrapper, "emit_on_success")
        return cast(F, sync_wrapper)

    return decorator


def emit_on_success_class(
    *,
    transform: Callable[[Any], Any] | None = None,
    use_events: bool = True,
    use_queue: bool = False,
    queue: str | None = None,
    topic: str | None = None,
    queue_metadata: dict[str, Any] | None = None,
    event_name: str | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
) -> Callable[[type], type]:
    """Class form: auto-apply @emit_on_success to every public method. Decision #4."""

    method_dec = emit_on_success(
        transform=transform,
        use_events=use_events,
        use_queue=use_queue,
        queue=queue,
        topic=topic,
        queue_metadata=queue_metadata,
        event_name=event_name,
    )

    def wrap(cls: type) -> type:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="emit_on_success",
            include=include,
            exclude=exclude,
            include_private=include_private,
        )

    return wrap

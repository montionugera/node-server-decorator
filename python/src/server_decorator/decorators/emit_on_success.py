"""@emit_on_success decorator (method form) + emit_on_success_class. Decisions #7 + D-C.

When `use_queue=True` is set on a sync method called outside an event loop, the side
effect runs on a single-worker `_EMIT_EXECUTOR` so the caller doesn't block (D-C).
Register `atexit(_EMIT_EXECUTOR.shutdown, wait=True)` for delivery on shutdown.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import inspect
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

from server_decorator import emitter as _emitter_mod
from server_decorator import logger as _logger_mod
from server_decorator.config import get_service
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname
from server_decorator.queue import registry as _registry_mod
from server_decorator.queue.message import QueueMessage

F = TypeVar("F", bound=Callable[..., Any])

# D-C: single-worker executor for sync-method fire-and-forget. I/O-bound and
# ordering matters, so one worker is fine. Drained on shutdown via atexit.
_EMIT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="server-decorator-emit"
)

# Strong references to in-flight create_task() futures so the GC doesn't drop them
# mid-flight (RUF006). Tasks self-remove via add_done_callback.
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


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
            payload = opts.transform(result) if opts.transform else result
            if opts.use_events:
                try:
                    _emitter_mod.global_emitter.emit(resolved_event, payload)
                except Exception as e:
                    _logger_mod.global_logger.error(f"Failed to emit event {resolved_event}: {e!r}")
            if opts.use_queue:
                try:
                    service = get_service()
                    auto_topic = resolved_event
                    if service and opts.topic is None:
                        auto_topic = f"{service}.{resolved_event}"
                    msg: QueueMessage = {
                        "eventName": resolved_event,
                        "payload": payload,
                        "timestamp": int(time.time() * 1000),
                        "metadata": {
                            "className": class_name,
                            "methodName": method_name,
                            "topic": opts.topic,
                            **({"service": service} if service else {}),
                            **opts.queue_metadata,  # type: ignore[typeddict-item]
                        },
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
                _EMIT_EXECUTOR.submit(asyncio.run, _on_success(result))
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

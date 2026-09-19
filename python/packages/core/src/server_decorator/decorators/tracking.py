"""@tracking decorator (method form) + tracking_class (class form). Decision #5."""

from __future__ import annotations

import functools
import inspect
import time
from collections.abc import Callable
from typing import Any, TypeVar, cast

from server_decorator import logger as _logger_mod
from server_decorator import tracker as _tracker_mod
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname

F = TypeVar("F", bound=Callable[..., Any])


def tracking(fn: F) -> F:
    """Track latency and error rate. Mirrors Node `@tracking`. Re-raises any exception."""
    qualname = shorten_qualname(fn.__qualname__)

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            start = time.monotonic()
            is_error = False
            try:
                return await fn(*args, **kwargs)
            except Exception as e:
                is_error = True
                _logger_mod.global_logger.error(f"[Tracking] {qualname} - Error: {e!r}")
                raise
            finally:
                latency_ms = int((time.monotonic() - start) * 1000)
                _tracker_mod.global_tracker.track(qualname, latency_ms, is_error)

        _mark_wrapped(async_wrapper, "tracking")
        return cast(F, async_wrapper)

    @functools.wraps(fn)
    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        start = time.monotonic()
        is_error = False
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            is_error = True
            _logger_mod.global_logger.error(f"[Tracking] {qualname} - Error: {e!r}")
            raise
        finally:
            latency_ms = int((time.monotonic() - start) * 1000)
            _tracker_mod.global_tracker.track(qualname, latency_ms, is_error)

    _mark_wrapped(sync_wrapper, "tracking")
    return cast(F, sync_wrapper)


def tracking_class(
    *,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type], type]:
    """Class form: auto-apply @tracking to every public method. Decision #4."""

    def wrap(cls: type) -> type:
        return apply_to_class(
            cls,
            tracking,
            decorator_name="tracking",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return wrap

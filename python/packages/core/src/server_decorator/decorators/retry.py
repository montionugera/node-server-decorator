"""@retry decorator (method form) + retry_class (class form)."""

from __future__ import annotations

import asyncio
import functools
import inspect
import random
import time
from collections.abc import Callable
from typing import Any, TypeVar, cast

from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class

F = TypeVar("F", bound=Callable[..., Any])
T = TypeVar("T", bound=type)


def retry(
    *,
    max_attempts: int = 3,
    backoff_ms: float = 50.0,
    max_backoff_ms: float = 2000.0,
    factor: float = 2.0,
    jitter: bool = True,
    retry_if: Callable[[Exception], bool] | None = None,
) -> Callable[[F], F]:
    """Wrap a method with exponential backoff and jitter retry semantics."""
    if not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or max_attempts < 1:
        raise ValueError(f"@retry: max_attempts must be an integer >= 1, got {max_attempts!r}")

    def decorator(fn: F) -> F:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                attempt = 0
                while True:
                    attempt += 1
                    try:
                        return await fn(*args, **kwargs)
                    except Exception as e:
                        if attempt >= max_attempts:
                            raise
                        if retry_if is not None and not retry_if(e):
                            raise

                        delay = (backoff_ms / 1000.0) * (factor ** (attempt - 1))
                        max_delay = max_backoff_ms / 1000.0
                        if delay > max_delay:
                            delay = max_delay
                        if jitter and delay > 0:
                            delay = random.uniform(0, delay)

                        if delay > 0:
                            await asyncio.sleep(delay)

            _mark_wrapped(async_wrapper, "retry")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            attempt = 0
            while True:
                attempt += 1
                try:
                    return fn(*args, **kwargs)
                except Exception as e:
                    if attempt >= max_attempts:
                        raise
                    if retry_if is not None and not retry_if(e):
                        raise

                    delay = (backoff_ms / 1000.0) * (factor ** (attempt - 1))
                    max_delay = max_backoff_ms / 1000.0
                    if delay > max_delay:
                        delay = max_delay
                    if jitter and delay > 0:
                        delay = random.uniform(0, delay)

                    if delay > 0:
                        time.sleep(delay)

        _mark_wrapped(sync_wrapper, "retry")
        return cast(F, sync_wrapper)

    return decorator


def retry_class(
    *,
    max_attempts: int = 3,
    backoff_ms: float = 50.0,
    max_backoff_ms: float = 2000.0,
    factor: float = 2.0,
    jitter: bool = True,
    retry_if: Callable[[Exception], bool] | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type[T]], type[T]]:
    """Class form: auto-wrap all qualifying public methods of cls with @retry."""
    method_dec = retry(
        max_attempts=max_attempts,
        backoff_ms=backoff_ms,
        max_backoff_ms=max_backoff_ms,
        factor=factor,
        jitter=jitter,
        retry_if=retry_if,
    )

    def decorator(cls: type[T]) -> type[T]:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="retry",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return decorator

"""@cache decorator (method form) + cache_class (class form). Decisions #6 + D-B.

The `CACHE_MISS` sentinel (D-B) lets users cache None/0/""/False as legitimate values:
adapters return CACHE_MISS for absent keys; the decorator uses identity comparison
(`cached is not CACHE_MISS`) to distinguish hit from miss.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, TypeVar, cast

from server_decorator.decorators._cache_key import build_cache_key
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname

F = TypeVar("F", bound=Callable[..., Any])

# D-B: distinct sentinel so adapters can signal "absent key" without colliding with
# legitimately-cached None/0/""/False values. Re-exported from the package barrel.
CACHE_MISS: Any = object()


class CacheAdapter(Protocol):
    def get(self, key: str) -> Any | Awaitable[Any]: ...
    def set(self, key: str, value: Any, ttl: int) -> Any | Awaitable[Any]: ...


def cache(adapter: CacheAdapter, ttl: int) -> Callable[[F], F]:
    def decorator(fn: F) -> F:
        qualname = shorten_qualname(fn.__qualname__)

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                key = build_cache_key(qualname, args, kwargs)
                cached = adapter.get(key)
                if inspect.isawaitable(cached):
                    cached = await cached
                if cached is not CACHE_MISS:
                    return cached
                result = await fn(*args, **kwargs)
                set_result = adapter.set(key, result, ttl)
                if inspect.isawaitable(set_result):
                    await set_result
                return result

            _mark_wrapped(async_wrapper, "cache")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            key = build_cache_key(qualname, args, kwargs)
            cached = adapter.get(key)
            if cached is not CACHE_MISS:
                return cached
            result = fn(*args, **kwargs)
            adapter.set(key, result, ttl)
            return result

        _mark_wrapped(sync_wrapper, "cache")
        return cast(F, sync_wrapper)

    return decorator


def cache_class(
    adapter: CacheAdapter,
    ttl: int,
    *,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
) -> Callable[[type], type]:
    """Class form: auto-apply @cache to every public method. Decision #4."""

    method_dec = cache(adapter, ttl)

    def wrap(cls: type) -> type:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="cache",
            include=include,
            exclude=exclude,
            include_private=include_private,
        )

    return wrap

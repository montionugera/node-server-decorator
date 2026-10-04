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

from server_decorator import logger as _logger_mod
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


def _has_receiver(fn: Callable[..., Any]) -> bool:
    """True when `fn` is declared as a method (first parameter named `self` or `cls`).

    cache-key.md: positional args exclude the receiver, otherwise the key embeds the
    instance repr (a memory address) and never matches across instances or languages.
    """
    try:
        params = list(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return False
    return bool(params) and params[0] in ("self", "cls")


def _log_set_failure(key: str, err: Exception) -> None:
    # Cache writes fail open (contracts/rules/cache-adapter.md): `fn` already ran, so a
    # failing `set` must not turn its result into an error the caller might retry on.
    _logger_mod.global_logger.warn(f"@cache: failed to write key {key}: {err!r}")


def cache(adapter: CacheAdapter, ttl: int) -> Callable[[F], F]:
    def decorator(fn: F) -> F:
        qualname = shorten_qualname(fn.__qualname__)
        skip = 1 if _has_receiver(fn) else 0

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                key = build_cache_key(qualname, args[skip:], kwargs)
                cached = adapter.get(key)
                if inspect.isawaitable(cached):
                    cached = await cached
                if cached is not CACHE_MISS:
                    return cached
                result = await fn(*args, **kwargs)
                try:
                    set_result = adapter.set(key, result, ttl)
                    if inspect.isawaitable(set_result):
                        await set_result
                except Exception as e:
                    _log_set_failure(key, e)
                return result

            _mark_wrapped(async_wrapper, "cache")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            key = build_cache_key(qualname, args[skip:], kwargs)
            cached = adapter.get(key)
            # I4: an async adapter's `get` returns an un-awaited coroutine here (sync_wrapper
            # never awaits). Left unchecked, a coroutine is never `is CACHE_MISS`, so this
            # silently takes the "hit" branch, hands the caller a bare coroutine object, and
            # `fn` never runs. Fail loudly instead of corrupting the caller's return type.
            if inspect.isawaitable(cached):
                close = getattr(cached, "close", None)
                if callable(close):
                    close()  # avoid a "coroutine was never awaited" RuntimeWarning
                raise TypeError(
                    "@cache: async adapter used with a sync function; "
                    "use an async function or a sync adapter"
                )
            if cached is not CACHE_MISS:
                return cached
            result = fn(*args, **kwargs)
            try:
                set_result = adapter.set(key, result, ttl)
            except Exception as e:
                _log_set_failure(key, e)
                return result
            # Same failure mode on the set path: an async adapter's `set` returns an
            # un-awaited coroutine that would otherwise be silently discarded (GC'd without
            # ever running, so nothing is actually cached).
            if inspect.isawaitable(set_result):
                close = getattr(set_result, "close", None)
                if callable(close):
                    close()  # avoid a "coroutine was never awaited" RuntimeWarning
                raise TypeError(
                    "@cache: async adapter used with a sync function; "
                    "use an async function or a sync adapter"
                )
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
    wrap_properties: bool = False,
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
            wrap_properties=wrap_properties,
        )

    return wrap

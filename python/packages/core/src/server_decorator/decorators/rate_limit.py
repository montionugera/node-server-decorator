"""@rate_limit decorator (method form) + rate_limit_class (class form)."""

from __future__ import annotations

import functools
import inspect
import threading
import time
from collections.abc import Callable
from typing import Any, TypeVar, cast

from server_decorator import logger as _logger_mod
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname
from server_decorator.decorators._warn_once import OncePerObject

F = TypeVar("F", bound=Callable[..., Any])
T = TypeVar("T", bound=type)


class RateLimitExceededError(Exception):
    def __init__(self, limit_key: str, message: str | None = None) -> None:
        super().__init__(message or f"Rate limit exceeded for '{limit_key}'")
        self.limit_key = limit_key


class TokenBucket:
    def __init__(self, capacity: float = 10.0, refill_rate: float = 5.0) -> None:
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = capacity
        self.last_refill = time.monotonic()
        self._lock = threading.Lock()

    def allow(self, cost: float = 1.0) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = max(0.0, now - self.last_refill)
            self.last_refill = now
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)

            if self.tokens >= cost:
                self.tokens -= cost
                return True
            return False

    def available_tokens(self) -> float:
        with self._lock:
            elapsed = max(0.0, time.monotonic() - self.last_refill)
            return min(self.capacity, self.tokens + elapsed * self.refill_rate)


_buckets: dict[str, TokenBucket] = {}
_registry_lock = threading.Lock()

# Idle-bucket eviction (contracts/rules/resilience.md): a bucket that has refilled to
# capacity is indistinguishable from a fresh one, so dropping it loses no state.
_EVICTION_SWEEP_MIN_SIZE = 1024
_next_sweep_size = _EVICTION_SWEEP_MIN_SIZE


def _evict_idle_buckets_locked() -> None:
    global _next_sweep_size
    for key in [k for k, b in _buckets.items() if b.available_tokens() >= b.capacity]:
        del _buckets[key]
    _next_sweep_size = max(_EVICTION_SWEEP_MIN_SIZE, len(_buckets) * 2)


def get_token_bucket(key: str, capacity: float, refill_rate: float) -> TokenBucket:
    with _registry_lock:
        bucket = _buckets.get(key)
        if bucket is None:
            if len(_buckets) >= _next_sweep_size:
                _evict_idle_buckets_locked()
            bucket = TokenBucket(capacity=capacity, refill_rate=refill_rate)
            _buckets[key] = bucket
        return bucket


def clear_rate_limiters() -> None:
    global _next_sweep_size
    with _registry_lock:
        _buckets.clear()
        _next_sweep_size = _EVICTION_SWEEP_MIN_SIZE


def rate_limit(
    *,
    capacity: float = 10.0,
    refill_rate: float = 5.0,
    cost: float = 1.0,
    key_extractor: Callable[..., str] | None = None,
) -> Callable[[F], F]:
    """Wrap a method with token-bucket rate limiting."""

    def decorator(fn: F) -> F:
        base_key = shorten_qualname(fn.__qualname__)
        warned = OncePerObject()

        def resolve(limit_key: str) -> TokenBucket:
            bucket = get_token_bucket(limit_key, capacity, refill_rate)
            if (bucket.capacity != capacity or bucket.refill_rate != refill_rate) and warned.first(
                bucket
            ):
                _logger_mod.global_logger.warn(
                    f"@rate_limit: bucket '{limit_key}' is already registered with "
                    f"different options; {fn.__qualname__} shares it and its own "
                    "capacity/refill_rate are ignored"
                )
            return bucket

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if key_extractor is not None:
                    suffix = key_extractor(*args, **kwargs)
                    limit_key = f"{base_key}:{suffix}"
                else:
                    limit_key = base_key

                bucket = resolve(limit_key)
                if not bucket.allow(cost):
                    raise RateLimitExceededError(limit_key)

                return await fn(*args, **kwargs)

            _mark_wrapped(async_wrapper, "rate_limit")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            if key_extractor is not None:
                suffix = key_extractor(*args, **kwargs)
                limit_key = f"{base_key}:{suffix}"
            else:
                limit_key = base_key

            bucket = resolve(limit_key)
            if not bucket.allow(cost):
                raise RateLimitExceededError(limit_key)

            return fn(*args, **kwargs)

        _mark_wrapped(sync_wrapper, "rate_limit")
        return cast(F, sync_wrapper)

    return decorator


def rate_limit_class(
    *,
    capacity: float = 10.0,
    refill_rate: float = 5.0,
    cost: float = 1.0,
    key_extractor: Callable[..., str] | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type[T]], type[T]]:
    """Class form: auto-wrap all qualifying public methods with @rate_limit."""
    method_dec = rate_limit(
        capacity=capacity,
        refill_rate=refill_rate,
        cost=cost,
        key_extractor=key_extractor,
    )

    def decorator(cls: type[T]) -> type[T]:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="rate_limit",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return decorator

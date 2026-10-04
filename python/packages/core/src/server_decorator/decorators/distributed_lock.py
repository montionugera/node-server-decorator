"""Redis distributed lock decorator for mutual exclusion across processes.

Implements single-instance Redis distributed locking with atomic Lua release,
token verification, unref'd heartbeat watchdog renewal, and contention queueing.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import random
import time
import uuid
from collections.abc import Callable
from typing import Any, Protocol, TypeVar

from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class

T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., Any])

RELEASE_LOCK_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
""".strip()

RENEW_LOCK_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
""".strip()


class LockAcquisitionError(Exception):
    """Raised when a distributed lock cannot be acquired within wait_timeout."""


class LockLostError(Exception):
    """Raised after the wrapped coroutine settles when the lease was lost while it ran.

    The lease is lost when a renewal returns 0, or when renewals keep failing for a
    full TTL. The coroutine's own result must be treated as unsafe: another instance
    may have been inside the same critical section.
    """


class RedisLockAdapter(Protocol):
    """Dependency-free protocol for Redis lock operations."""

    async def set_nx_px(self, key: str, value: str, ttl_ms: int) -> bool: ...
    async def eval_lua(self, script: str, keys: list[str], args: list[Any]) -> Any: ...


_global_lock_adapter: RedisLockAdapter | None = None


def configure_distributed_lock(adapter: RedisLockAdapter) -> None:
    """Set default RedisLockAdapter for distributed locks."""
    global _global_lock_adapter
    _global_lock_adapter = adapter


def get_global_distributed_lock_adapter() -> RedisLockAdapter | None:
    """Get the currently configured default RedisLockAdapter."""
    return _global_lock_adapter


def clear_global_distributed_lock_adapter() -> None:
    """Clear the currently configured default RedisLockAdapter."""
    global _global_lock_adapter
    _global_lock_adapter = None


def distributed_lock(
    key: str | Callable[..., str],
    *,
    ttl_seconds: float = 10.0,
    wait_timeout_seconds: float = 0.0,
    retry_interval_seconds: float = 0.1,
    auto_renew: bool = True,
    fallback: Callable[..., Any] | None = None,
    adapter: RedisLockAdapter | None = None,
) -> Callable[[F], F]:
    """Method decorator guaranteeing distributed mutual exclusion backed by Redis."""
    ttl_ms = int(ttl_seconds * 1000)

    def decorator(fn: F) -> F:
        if not inspect.iscoroutinefunction(fn):
            raise TypeError(f"@distributed_lock requires an async coroutine function, got {fn}")

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            active_adapter = adapter or _global_lock_adapter
            if active_adapter is None:
                raise RuntimeError(
                    f"DistributedLock: No RedisLockAdapter provided for method '{fn.__name__}'. "
                    "Pass an adapter in @distributed_lock(adapter=...) or call "
                    "configure_distributed_lock(adapter)."
                )

            # Resolve lock key
            if callable(key):
                lock_key = key(*args, **kwargs)
            else:
                lock_key = key

            token = str(uuid.uuid4())
            start_time = time.monotonic()
            acquired = False
            # Last instant the lease was known to be ours (taken before the confirming call).
            last_confirmed = start_time

            # Contention acquisition loop
            while not acquired:
                last_confirmed = time.monotonic()
                acquired = await active_adapter.set_nx_px(lock_key, token, ttl_ms)
                if acquired:
                    break

                elapsed = time.monotonic() - start_time
                if elapsed >= wait_timeout_seconds:
                    break

                # Randomized jitter (±20%)
                jitter = (random.random() * 0.4 - 0.2) * retry_interval_seconds
                sleep_time = max(
                    0.01, min(retry_interval_seconds + jitter, wait_timeout_seconds - elapsed)
                )
                await asyncio.sleep(sleep_time)

            if not acquired:
                if fallback is not None:
                    res = fallback(*args, **kwargs)
                    if inspect.isawaitable(res):
                        return await res
                    return res
                raise LockAcquisitionError(
                    f"Failed to acquire lock for '{lock_key}' within {wait_timeout_seconds}s"
                )

            # Heartbeat watchdog renewal task
            watchdog_task: asyncio.Task[None] | None = None
            lock_lost = False

            async def _heartbeat() -> None:
                nonlocal lock_lost, last_confirmed
                renew_period = max(0.02, ttl_seconds / 3.0)
                while True:
                    await asyncio.sleep(renew_period)
                    sent_at = time.monotonic()
                    try:
                        res = await active_adapter.eval_lua(
                            RENEW_LOCK_LUA, [lock_key], [token, ttl_ms]
                        )
                    except Exception:
                        # A raised renewal is "unknown", not "lost": retry on the next
                        # tick. Only once a full TTL has passed without a confirmed
                        # renewal has the lease certainly expired.
                        if time.monotonic() - last_confirmed >= ttl_seconds:
                            lock_lost = True
                            break
                        continue
                    if not res or res == 0:
                        lock_lost = True
                        break
                    last_confirmed = sent_at

            if auto_renew:
                watchdog_task = asyncio.create_task(_heartbeat())

            # The wrapper's own outcome. sys.exc_info() would also report an exception
            # being handled in the caller's frame, hiding a lost lease from a caller
            # that awaits us inside an `except BaseException` block.
            failure: BaseException | None = None
            try:
                result = await fn(*args, **kwargs)
            except BaseException as exc:
                failure = exc
                raise
            finally:
                try:
                    if watchdog_task is not None:
                        watchdog_task.cancel()
                        # gather absorbs only the watchdog's own outcome; a cancellation
                        # aimed at this task still propagates.
                        await asyncio.gather(watchdog_task, return_exceptions=True)
                finally:
                    # Always attempt the release: the script is token-guarded, so it is a
                    # no-op when the lease is no longer ours.
                    try:
                        res = await active_adapter.eval_lua(RELEASE_LOCK_LUA, [lock_key], [token])
                    except Exception:
                        if time.monotonic() - last_confirmed >= ttl_seconds:
                            lock_lost = True
                    else:
                        if isinstance(res, int) and not isinstance(res, bool) and res == 0:
                            lock_lost = True

                # Fail closed on a lost lease, but never mask a cancellation in flight.
                if lock_lost and (failure is None or isinstance(failure, Exception)):
                    raise LockLostError(
                        f"Lock for '{lock_key}' was lost while '{fn.__name__}' was running"
                    )
            return result

        _mark_wrapped(async_wrapper, "distributed_lock")
        return async_wrapper  # type: ignore[return-value]

    return decorator


def distributed_lock_class(
    key_prefix: str = "lock",
    *,
    ttl_seconds: float = 10.0,
    wait_timeout_seconds: float = 0.0,
    retry_interval_seconds: float = 0.1,
    auto_renew: bool = True,
    fallback: Callable[..., Any] | None = None,
    adapter: RedisLockAdapter | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type[T]], type[T]]:
    """Class form: auto-wrap all qualifying public async methods with @distributed_lock."""

    def decorator(cls: type[T]) -> type[T]:
        def method_dec(fn: Callable[..., Any]) -> Callable[..., Any]:
            if not inspect.iscoroutinefunction(fn):
                return fn  # sync methods / property accessors are skipped, not rejected
            method_key = f"{key_prefix}:{cls.__name__}:{fn.__name__}"
            return distributed_lock(
                method_key,
                ttl_seconds=ttl_seconds,
                wait_timeout_seconds=wait_timeout_seconds,
                retry_interval_seconds=retry_interval_seconds,
                auto_renew=auto_renew,
                fallback=fallback,
                adapter=adapter,
            )(fn)

        return apply_to_class(
            cls,
            method_dec,
            decorator_name="distributed_lock",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return decorator

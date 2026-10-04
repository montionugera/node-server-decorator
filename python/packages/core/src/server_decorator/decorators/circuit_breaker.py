"""@circuit_breaker decorator (method form) + circuit_breaker_class (class form)."""

from __future__ import annotations

import enum
import functools
import inspect
import threading
import time
from collections.abc import Callable
from typing import Any, TypeVar, cast

from server_decorator import logger as _logger_mod
from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.decorators._qualname import shorten_qualname

F = TypeVar("F", bound=Callable[..., Any])
T = TypeVar("T", bound=type)


class CircuitState(str, enum.Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half-open"


class CircuitBreakerOpenError(Exception):
    def __init__(self, breaker_name: str, message: str | None = None) -> None:
        super().__init__(message or f"Circuit breaker '{breaker_name}' is open")
        self.breaker_name = breaker_name


class CircuitBreaker:
    def __init__(
        self,
        name: str = "default",
        failure_threshold: int = 5,
        recovery_timeout_ms: float = 5000.0,
        half_open_success_threshold: int = 2,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout_ms = recovery_timeout_ms
        self.half_open_success_threshold = half_open_success_threshold

        self._state = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._consecutive_successes = 0
        self._last_state_change = time.monotonic()
        self._lock = threading.Lock()
        # Probes admitted in HALF_OPEN whose result has not been recorded yet.
        self._half_open_in_flight = 0
        # Bumped on every state transition; a result recorded with an older epoch is stale.
        self._epoch = 0

    def _transition_locked(self, to: CircuitState) -> None:
        self._state = to
        self._epoch += 1
        self._half_open_in_flight = 0
        self._consecutive_successes = 0
        self._last_state_change = time.monotonic()

    def _refresh_locked(self) -> CircuitState:
        elapsed_ms = (time.monotonic() - self._last_state_change) * 1000.0
        if self._state == CircuitState.OPEN and elapsed_ms >= self.recovery_timeout_ms:
            self._transition_locked(CircuitState.HALF_OPEN)
            self._consecutive_failures = 0
        return self._state

    @property
    def state(self) -> CircuitState:
        with self._lock:
            return self._refresh_locked()

    def acquire(self) -> int | None:
        """Admit a call: the admission epoch to pass back to record_*, or None to reject.

        In HALF_OPEN at most ``half_open_success_threshold`` probes are in flight at once.
        """
        with self._lock:
            s = self._refresh_locked()
            if s == CircuitState.OPEN:
                return None
            if s == CircuitState.HALF_OPEN:
                if self._half_open_in_flight >= self.half_open_success_threshold:
                    now = time.monotonic()
                    if (now - self._last_state_change) * 1000.0 < self.recovery_timeout_ms:
                        return None
                    # Probes that never reported back are treated as abandoned.
                    self._half_open_in_flight = 0
                    self._last_state_change = now
                self._half_open_in_flight += 1
            return self._epoch

    def allow_request(self) -> bool:
        return self.acquire() is not None

    def record_success(self, epoch: int | None = None) -> None:
        with self._lock:
            if epoch is not None and epoch != self._epoch:
                return
            if self._state == CircuitState.HALF_OPEN:
                if self._half_open_in_flight > 0:
                    self._half_open_in_flight -= 1
                self._consecutive_successes += 1
                if self._consecutive_successes >= self.half_open_success_threshold:
                    self._transition_locked(CircuitState.CLOSED)
                    self._consecutive_failures = 0
            elif self._state == CircuitState.CLOSED:
                self._consecutive_failures = 0

    def record_failure(self, epoch: int | None = None) -> None:
        with self._lock:
            if epoch is not None and epoch != self._epoch:
                return
            if self._state == CircuitState.HALF_OPEN:
                self._transition_locked(CircuitState.OPEN)
                self._consecutive_failures += 1
            elif self._state == CircuitState.CLOSED:
                self._consecutive_failures += 1
                if self._consecutive_failures >= self.failure_threshold:
                    self._transition_locked(CircuitState.OPEN)

    def reset(self) -> None:
        with self._lock:
            self._transition_locked(CircuitState.CLOSED)
            self._consecutive_failures = 0


_circuit_breakers: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_circuit_breaker(
    name: str,
    *,
    failure_threshold: int = 5,
    recovery_timeout_ms: float = 5000.0,
    half_open_success_threshold: int = 2,
) -> CircuitBreaker:
    with _registry_lock:
        cb = _circuit_breakers.get(name)
        if cb is None:
            cb = CircuitBreaker(
                name=name,
                failure_threshold=failure_threshold,
                recovery_timeout_ms=recovery_timeout_ms,
                half_open_success_threshold=half_open_success_threshold,
            )
            _circuit_breakers[name] = cb
        return cb


def clear_circuit_breakers() -> None:
    with _registry_lock:
        _circuit_breakers.clear()


def circuit_breaker(
    *,
    name: str | None = None,
    failure_threshold: int = 5,
    recovery_timeout_ms: float = 5000.0,
    half_open_success_threshold: int = 2,
    fallback: Callable[..., Any] | None = None,
) -> Callable[[F], F]:
    """Wrap a method with 3-state circuit breaker protection."""

    def decorator(fn: F) -> F:
        breaker_name = name or shorten_qualname(fn.__qualname__)

        def resolve() -> CircuitBreaker:
            # Resolved per call so a registry clear is honoured by decorated methods.
            return get_circuit_breaker(
                breaker_name,
                failure_threshold=failure_threshold,
                recovery_timeout_ms=recovery_timeout_ms,
                half_open_success_threshold=half_open_success_threshold,
            )

        registered = resolve()
        if (
            registered.failure_threshold != failure_threshold
            or registered.recovery_timeout_ms != recovery_timeout_ms
            or registered.half_open_success_threshold != half_open_success_threshold
        ):
            _logger_mod.global_logger.warn(
                f"@circuit_breaker: breaker '{breaker_name}' is already registered with "
                f"different options; {fn.__qualname__} shares it and its own thresholds "
                "are ignored"
            )

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                cb = resolve()
                epoch = cb.acquire()
                if epoch is None:
                    err = CircuitBreakerOpenError(breaker_name)
                    if fallback is not None:
                        res = fallback(err, *args, **kwargs)
                        return await res if inspect.isawaitable(res) else res
                    raise err

                try:
                    result = await fn(*args, **kwargs)
                    cb.record_success(epoch)
                    return result
                except Exception as e:
                    cb.record_failure(epoch)
                    if fallback is not None:
                        res = fallback(e, *args, **kwargs)
                        return await res if inspect.isawaitable(res) else res
                    raise

            _mark_wrapped(async_wrapper, "circuit_breaker")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            cb = resolve()
            epoch = cb.acquire()
            if epoch is None:
                err = CircuitBreakerOpenError(breaker_name)
                if fallback is not None:
                    return fallback(err, *args, **kwargs)
                raise err

            try:
                result = fn(*args, **kwargs)
                cb.record_success(epoch)
                return result
            except Exception as e:
                cb.record_failure(epoch)
                if fallback is not None:
                    return fallback(e, *args, **kwargs)
                raise

        _mark_wrapped(sync_wrapper, "circuit_breaker")
        return cast(F, sync_wrapper)

    return decorator


def circuit_breaker_class(
    *,
    name: str | None = None,
    failure_threshold: int = 5,
    recovery_timeout_ms: float = 5000.0,
    half_open_success_threshold: int = 2,
    fallback: Callable[..., Any] | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type[T]], type[T]]:
    """Class form: auto-wrap all qualifying public methods with @circuit_breaker."""
    method_dec = circuit_breaker(
        name=name,
        failure_threshold=failure_threshold,
        recovery_timeout_ms=recovery_timeout_ms,
        half_open_success_threshold=half_open_success_threshold,
        fallback=fallback,
    )

    def decorator(cls: type[T]) -> type[T]:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="circuit_breaker",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return decorator

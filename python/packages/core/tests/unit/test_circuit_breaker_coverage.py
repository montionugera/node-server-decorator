"""Unit coverage for circuit_breaker.py: stale/no-op result recording, half-open probe
admission and the async wrapper's fallback paths."""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from server_decorator import logger as logger_mod

cb_mod = importlib.import_module("server_decorator.decorators.circuit_breaker")
CircuitBreaker = cb_mod.CircuitBreaker
CircuitBreakerOpenError = cb_mod.CircuitBreakerOpenError
CircuitState = cb_mod.CircuitState
circuit_breaker = cb_mod.circuit_breaker
circuit_breaker_class = cb_mod.circuit_breaker_class
clear_circuit_breakers = cb_mod.clear_circuit_breakers
get_circuit_breaker = cb_mod.get_circuit_breaker


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def advance_ms(self, ms: float) -> None:
        self.now += ms / 1000.0


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(cb_mod, "time", SimpleNamespace(monotonic=c.monotonic))
    return c


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    clear_circuit_breakers()
    yield
    clear_circuit_breakers()


def _open(cb: Any) -> None:
    for _ in range(cb.failure_threshold):
        cb.record_failure()
    assert cb._state == CircuitState.OPEN


# ------------------------------------------------------------------------ state machine


def test_open_error_message_and_name() -> None:
    default = CircuitBreakerOpenError("payments")
    custom = CircuitBreakerOpenError("payments", "try later")

    assert str(default) == "Circuit breaker 'payments' is open"
    assert str(custom) == "try later"
    assert default.breaker_name == custom.breaker_name == "payments"


def test_results_recorded_while_open_are_ignored(clock: _Clock) -> None:
    cb = CircuitBreaker(failure_threshold=2, recovery_timeout_ms=1000)
    _open(cb)
    epoch, failures = cb._epoch, cb._consecutive_failures

    cb.record_success()
    cb.record_failure()

    assert cb._state == CircuitState.OPEN
    assert cb._epoch == epoch
    assert cb._consecutive_failures == failures
    assert cb.acquire() is None
    assert cb.allow_request() is False


def test_open_stays_open_just_before_timeout_and_half_opens_at_it(clock: _Clock) -> None:
    cb = CircuitBreaker(failure_threshold=1, recovery_timeout_ms=1000)
    _open(cb)

    clock.advance_ms(999)
    assert cb.state == CircuitState.OPEN
    clock.advance_ms(1)
    assert cb.state == CircuitState.HALF_OPEN
    assert cb._consecutive_failures == 0


def test_zero_recovery_timeout_half_opens_immediately(clock: _Clock) -> None:
    cb = CircuitBreaker(failure_threshold=1, recovery_timeout_ms=0)
    _open(cb)

    assert cb.state == CircuitState.HALF_OPEN


def test_stale_epoch_results_do_not_change_state(clock: _Clock) -> None:
    cb = CircuitBreaker(failure_threshold=1, recovery_timeout_ms=1000)
    stale = cb.acquire()
    assert stale == 0
    _open(cb)
    clock.advance_ms(1000)
    assert cb.state == CircuitState.HALF_OPEN

    # A call admitted while CLOSED reports back after the breaker moved on.
    cb.record_failure(stale)
    cb.record_success(stale)

    assert cb._state == CircuitState.HALF_OPEN
    assert cb._consecutive_successes == 0


def test_half_open_admits_at_most_threshold_probes(clock: _Clock) -> None:
    cb = CircuitBreaker(
        failure_threshold=1, recovery_timeout_ms=1000, half_open_success_threshold=2
    )
    _open(cb)
    clock.advance_ms(1000)

    first, second = cb.acquire(), cb.acquire()

    assert first is not None and first == second == cb._epoch
    assert cb.acquire() is None
    assert cb._half_open_in_flight == 2


def test_half_open_abandoned_probes_are_reclaimed_after_recovery_timeout(clock: _Clock) -> None:
    cb = CircuitBreaker(
        failure_threshold=1, recovery_timeout_ms=1000, half_open_success_threshold=1
    )
    _open(cb)
    clock.advance_ms(1000)
    assert cb.acquire() is not None
    assert cb.acquire() is None

    clock.advance_ms(999)
    assert cb.acquire() is None
    clock.advance_ms(1)
    assert cb.acquire() is not None

    assert cb._state == CircuitState.HALF_OPEN
    assert cb._half_open_in_flight == 1
    # The reclaim restarts the abandonment window.
    assert cb.acquire() is None


def test_half_open_closes_after_threshold_successes_and_reopens_on_failure(clock: _Clock) -> None:
    cb = CircuitBreaker(
        failure_threshold=1, recovery_timeout_ms=1000, half_open_success_threshold=2
    )
    _open(cb)
    clock.advance_ms(1000)

    e1 = cb.acquire()
    cb.record_success(e1)
    assert cb._state == CircuitState.HALF_OPEN
    assert cb._half_open_in_flight == 0
    e2 = cb.acquire()
    cb.record_success(e2)
    assert cb._state == CircuitState.CLOSED
    assert cb._consecutive_failures == 0

    _open(cb)
    clock.advance_ms(1000)
    probe = cb.acquire()
    cb.record_failure(probe)
    assert cb._state == CircuitState.OPEN
    assert cb.acquire() is None


def test_half_open_success_without_in_flight_probe_does_not_go_negative(clock: _Clock) -> None:
    cb = CircuitBreaker(
        failure_threshold=1, recovery_timeout_ms=1000, half_open_success_threshold=3
    )
    _open(cb)
    clock.advance_ms(1000)
    assert cb.state == CircuitState.HALF_OPEN

    # No probe was admitted, so an epoch-less success is not a probe result.
    cb.record_success()

    assert cb._half_open_in_flight == 0
    assert cb._consecutive_successes == 0

    # A duplicate record for one admitted probe must not drive the count negative.
    probe = cb.acquire()
    cb.record_success(probe)
    cb.record_success(probe)

    assert cb._half_open_in_flight == 0
    assert cb._consecutive_successes == 2


def test_closed_success_resets_failure_streak() -> None:
    cb = CircuitBreaker(failure_threshold=3)
    cb.record_failure()
    cb.record_failure()
    cb.record_success()
    cb.record_failure()
    cb.record_failure()

    assert cb.state == CircuitState.CLOSED
    cb.record_failure()
    assert cb.state == CircuitState.OPEN


def test_reset_closes_and_invalidates_older_epochs() -> None:
    cb = CircuitBreaker(failure_threshold=1)
    old = cb.acquire()
    _open(cb)

    cb.reset()

    assert cb._state == CircuitState.CLOSED
    assert cb._consecutive_failures == 0
    cb.record_failure(old)
    assert cb._state == CircuitState.CLOSED


def test_registry_returns_same_breaker_and_ignores_later_options() -> None:
    first = get_circuit_breaker("svc", failure_threshold=2)
    second = get_circuit_breaker("svc", failure_threshold=9)

    assert first is second
    assert second.failure_threshold == 2

    clear_circuit_breakers()
    assert get_circuit_breaker("svc", failure_threshold=9) is not first


def test_conflicting_options_on_shared_name_warn(monkeypatch: pytest.MonkeyPatch) -> None:
    warnings: list[object] = []
    monkeypatch.setattr(
        logger_mod, "global_logger", SimpleNamespace(warn=warnings.append), raising=True
    )

    @circuit_breaker(name="shared", failure_threshold=2)
    def a() -> int:
        return 1

    assert warnings == []

    @circuit_breaker(name="shared", failure_threshold=7)
    def b() -> int:
        return 2

    assert len(warnings) == 1
    assert "'shared' is already registered with different options" in str(warnings[0])
    assert get_circuit_breaker("shared").failure_threshold == 2


# ------------------------------------------------------------------------ async wrapper


async def test_async_failure_uses_sync_fallback_and_still_counts_failure() -> None:
    seen: list[tuple[BaseException, tuple[Any, ...], dict[str, Any]]] = []

    def fallback(err: BaseException, *args: Any, **kwargs: Any) -> str:
        seen.append((err, args, kwargs))
        return "fallback"

    @circuit_breaker(name="a-sync-fb", failure_threshold=2, fallback=fallback)
    async def call(x: int, *, y: int = 0) -> str:
        raise ConnectionError("down")

    assert await call(1, y=2) == "fallback"

    err, args, kwargs = seen[0]
    assert isinstance(err, ConnectionError)
    assert args == (1,) and kwargs == {"y": 2}
    assert get_circuit_breaker("a-sync-fb")._consecutive_failures == 1


async def test_async_failure_awaits_async_fallback() -> None:
    async def fallback(err: BaseException, x: int) -> str:
        return f"async-fallback:{type(err).__name__}:{x}"

    @circuit_breaker(name="a-async-fb", failure_threshold=5, fallback=fallback)
    async def call(x: int) -> str:
        raise TimeoutError

    assert await call(3) == "async-fallback:TimeoutError:3"


async def test_async_open_circuit_skips_fn_and_uses_fallback_with_open_error() -> None:
    calls = 0
    errors: list[BaseException] = []

    def sync_fallback(err: BaseException) -> str:
        errors.append(err)
        return "cached"

    @circuit_breaker(
        name="a-open", failure_threshold=1, recovery_timeout_ms=60_000, fallback=sync_fallback
    )
    async def call() -> str:
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    assert await call() == "cached"
    assert await call() == "cached"

    assert calls == 1
    assert isinstance(errors[0], RuntimeError)
    assert isinstance(errors[1], CircuitBreakerOpenError)
    assert errors[1].breaker_name == "a-open"


async def test_async_open_circuit_awaits_async_fallback() -> None:
    async def fallback(err: BaseException) -> str:
        return type(err).__name__

    @circuit_breaker(
        name="a-open-async", failure_threshold=1, recovery_timeout_ms=60_000, fallback=fallback
    )
    async def call() -> str:
        raise RuntimeError("boom")

    assert await call() == "RuntimeError"
    assert await call() == "CircuitBreakerOpenError"


async def test_async_without_fallback_raises_original_then_open_error() -> None:
    @circuit_breaker(name="a-raise", failure_threshold=1, recovery_timeout_ms=60_000)
    async def call() -> str:
        raise KeyError("k")

    with pytest.raises(KeyError):
        await call()
    with pytest.raises(CircuitBreakerOpenError, match="'a-raise' is open"):
        await call()


async def test_async_fallback_exception_propagates() -> None:
    def fallback(err: BaseException) -> str:
        raise LookupError("fallback failed too")

    @circuit_breaker(name="a-fb-raises", failure_threshold=3, fallback=fallback)
    async def call() -> str:
        raise RuntimeError("boom")

    with pytest.raises(LookupError, match="fallback failed too"):
        await call()
    assert get_circuit_breaker("a-fb-raises")._consecutive_failures == 1


async def test_async_success_returns_value_and_resets_streak() -> None:
    outcomes = iter([RuntimeError("x"), None, None])

    @circuit_breaker(name="a-ok", failure_threshold=2)
    async def call() -> str:
        err = next(outcomes)
        if err is not None:
            raise err
        return "ok"

    with pytest.raises(RuntimeError):
        await call()
    assert await call() == "ok"
    assert get_circuit_breaker("a-ok")._consecutive_failures == 0
    assert call.__name__ == "call"


async def test_registry_clear_is_honoured_by_decorated_function() -> None:
    @circuit_breaker(name="a-clear", failure_threshold=1, recovery_timeout_ms=60_000)
    async def call() -> str:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await call()
    with pytest.raises(CircuitBreakerOpenError):
        await call()

    clear_circuit_breakers()

    with pytest.raises(RuntimeError):
        await call()


# ------------------------------------------------------------------------- sync wrapper


def test_sync_fallback_receives_error_for_failure_and_open_circuit() -> None:
    errors: list[str] = []

    def fallback(err: BaseException, x: int) -> int:
        errors.append(type(err).__name__)
        return -x

    @circuit_breaker(
        name="s-fb", failure_threshold=1, recovery_timeout_ms=60_000, fallback=fallback
    )
    def call(x: int) -> int:
        raise ZeroDivisionError

    assert call(4) == -4
    assert call(5) == -5
    assert errors == ["ZeroDivisionError", "CircuitBreakerOpenError"]


def test_sync_base_exception_is_not_counted_or_swallowed() -> None:
    @circuit_breaker(name="s-base", failure_threshold=1, fallback=lambda e: "never")
    def call() -> str:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        call()
    assert get_circuit_breaker("s-base")._consecutive_failures == 0
    assert get_circuit_breaker("s-base")._state == CircuitState.CLOSED


# --------------------------------------------------------------------------- class form


async def test_class_form_wraps_public_methods_sharing_one_named_breaker() -> None:
    @circuit_breaker_class(
        name="cls", failure_threshold=1, recovery_timeout_ms=60_000, exclude=("skipped",)
    )
    class Client:
        async def fetch(self) -> str:
            raise RuntimeError("down")

        def ping(self) -> str:
            return "pong"

        def skipped(self) -> str:
            return "raw"

        def _private(self) -> str:
            return "private"

    c = Client()
    with pytest.raises(RuntimeError):
        await c.fetch()

    with pytest.raises(CircuitBreakerOpenError):
        c.ping()
    assert c.skipped() == "raw"
    assert c._private() == "private"

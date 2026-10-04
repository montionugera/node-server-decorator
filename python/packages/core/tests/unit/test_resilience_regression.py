"""Regression tests for confirmed resilience bugs (retry / circuit breaker / rate limit)."""

from __future__ import annotations

import asyncio
import importlib
import threading
import time
from typing import Any

import pytest

from server_decorator import logger as logger_mod
from server_decorator.decorators.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    CircuitState,
    circuit_breaker,
    clear_circuit_breakers,
    get_circuit_breaker,
)
from server_decorator.decorators.rate_limit import (
    RateLimitExceededError,
    clear_rate_limiters,
    rate_limit,
)
from server_decorator.decorators.retry import retry, retry_class

# The package re-exports functions named like the submodules, so resolve the modules by path.
cb_mod = importlib.import_module("server_decorator.decorators.circuit_breaker")
rl_mod = importlib.import_module("server_decorator.decorators.rate_limit")


@pytest.fixture(autouse=True)
def clean_registries():
    clear_circuit_breakers()
    clear_rate_limiters()
    yield
    clear_circuit_breakers()
    clear_rate_limiters()


# --- retry: max_attempts validation -------------------------------------------------


@pytest.mark.parametrize("bad", [0, -1, 2.5, float("nan"), True, "3", None])
def test_retry_rejects_invalid_max_attempts_at_decoration_time(bad: Any) -> None:
    with pytest.raises(ValueError, match="max_attempts"):
        retry(max_attempts=bad)


def test_retry_class_rejects_invalid_max_attempts() -> None:
    with pytest.raises(ValueError, match="max_attempts"):
        retry_class(max_attempts=0)


def test_retry_max_attempts_one_runs_once_and_propagates_sync() -> None:
    calls = 0

    @retry(max_attempts=1, backoff_ms=0)
    def write() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        write()
    assert calls == 1


async def test_retry_max_attempts_one_runs_once_and_propagates_async() -> None:
    calls = 0

    @retry(max_attempts=1, backoff_ms=0)
    async def write() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await write()
    assert calls == 1


# --- circuit breaker: half-open probe limit -----------------------------------------


def test_half_open_admits_at_most_threshold_concurrent_probes_threads() -> None:
    calls = 0
    calls_lock = threading.Lock()

    @circuit_breaker(
        name="probe-limit",
        failure_threshold=1,
        recovery_timeout_ms=30,
        half_open_success_threshold=2,
    )
    def call() -> None:
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.05)
        raise RuntimeError("still down")

    with pytest.raises(RuntimeError):
        call()
    time.sleep(0.05)
    calls = 0

    rejected = 0
    start = threading.Barrier(50)

    def worker() -> None:
        nonlocal rejected
        start.wait()
        try:
            call()
        except CircuitBreakerOpenError:
            with calls_lock:
                rejected += 1
        except RuntimeError:
            pass

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert 1 <= calls <= 2
    assert rejected == 50 - calls


async def test_half_open_admits_at_most_threshold_concurrent_probes_async() -> None:
    calls = 0

    @circuit_breaker(
        name="probe-limit-async",
        failure_threshold=1,
        recovery_timeout_ms=30,
        half_open_success_threshold=2,
    )
    async def call() -> None:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.02)
        raise RuntimeError("still down")

    with pytest.raises(RuntimeError):
        await call()
    await asyncio.sleep(0.05)
    calls = 0

    results = await asyncio.gather(*(call() for _ in range(50)), return_exceptions=True)
    assert 1 <= calls <= 2
    assert sum(isinstance(r, CircuitBreakerOpenError) for r in results) == 50 - calls


async def test_results_of_calls_admitted_before_trip_are_not_probes() -> None:
    gate = asyncio.Event()
    fail = False

    @circuit_breaker(
        name="stale",
        failure_threshold=1,
        recovery_timeout_ms=20,
        half_open_success_threshold=2,
    )
    async def call() -> str:
        if fail:
            raise RuntimeError("down")
        await gate.wait()
        return "ok"

    slow1 = asyncio.ensure_future(call())
    slow2 = asyncio.ensure_future(call())
    await asyncio.sleep(0)  # both admitted while CLOSED
    fail = True
    with pytest.raises(RuntimeError):
        await call()
    cb = get_circuit_breaker("stale")
    assert cb.state == CircuitState.OPEN

    await asyncio.sleep(0.03)
    assert cb.state == CircuitState.HALF_OPEN
    gate.set()
    await asyncio.gather(slow1, slow2)
    assert cb.state == CircuitState.HALF_OPEN


def test_probe_slot_released_on_record_and_closes_after_successes() -> None:
    cb = CircuitBreaker(
        name="seq", failure_threshold=1, recovery_timeout_ms=10, half_open_success_threshold=2
    )
    cb.record_failure()
    time.sleep(0.02)
    assert cb.allow_request()
    assert cb.allow_request()
    assert not cb.allow_request()
    cb.record_success()
    assert cb.allow_request()
    cb.record_success()
    assert cb.state == CircuitState.CLOSED


def test_abandoned_probe_slots_are_reclaimed_after_recovery_timeout() -> None:
    cb = CircuitBreaker(
        name="abandoned",
        failure_threshold=1,
        recovery_timeout_ms=10,
        half_open_success_threshold=1,
    )
    cb.record_failure()
    time.sleep(0.02)
    assert cb.allow_request()  # never recorded
    assert not cb.allow_request()
    time.sleep(0.02)
    assert cb.allow_request()


# --- rate limit: idle bucket eviction -----------------------------------------------


def test_fully_refilled_buckets_are_evicted(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(rl_mod.time, "monotonic", lambda: now[0])

    @rate_limit(capacity=1, refill_rate=1, key_extractor=lambda i: str(i))
    def hit(i: int) -> str:
        return "ok"

    for i in range(2000):
        hit(i)
    now[0] += 10.0  # every bucket above has refilled to capacity
    for i in range(2000, 2100):
        hit(i)
    assert len(rl_mod._buckets) < 200


def test_drained_buckets_are_never_evicted(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(rl_mod.time, "monotonic", lambda: now[0])

    @rate_limit(capacity=1, refill_rate=0.001, key_extractor=lambda i: str(i))
    def hit(i: int) -> str:
        return "ok"

    for i in range(2100):
        hit(i)
    now[0] += 1.0
    with pytest.raises(RateLimitExceededError):
        hit(0)
    assert len(rl_mod._buckets) == 2100


def test_token_bucket_clamps_negative_elapsed(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(rl_mod.time, "monotonic", lambda: now[0])
    bucket = rl_mod.TokenBucket(capacity=10, refill_rate=5)
    now[0] = 0.0
    assert bucket.available_tokens() == 10
    assert bucket.allow()
    assert bucket.available_tokens() == 9


# --- registry: option shadowing + clear ---------------------------------------------


def test_warns_when_breaker_name_reused_with_different_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    warnings: list[str] = []

    class _Capture:
        def debug(self, msg: object) -> None: ...
        def info(self, msg: object) -> None: ...
        def warn(self, msg: object) -> None:
            warnings.append(str(msg))

        def error(self, msg: object) -> None: ...

    monkeypatch.setattr(logger_mod, "global_logger", _Capture())

    @circuit_breaker(name="shared", failure_threshold=1)
    def a() -> str:
        return "a"

    @circuit_breaker(name="shared", failure_threshold=1)
    def same() -> str:
        return "same"

    assert warnings == []

    @circuit_breaker(name="shared", failure_threshold=7)
    def b() -> str:
        return "b"

    assert len(warnings) == 1
    assert "shared" in warnings[0]
    assert (a(), same(), b()) == ("a", "same", "b")


def test_clear_resets_decorated_methods_and_keeps_registry_in_sync() -> None:
    fail = True

    @circuit_breaker(name="A.probe", failure_threshold=1, recovery_timeout_ms=60_000)
    def probe() -> str:
        if fail:
            raise RuntimeError("down")
        return "ok"

    with pytest.raises(RuntimeError):
        probe()
    with pytest.raises(CircuitBreakerOpenError):
        probe()

    clear_circuit_breakers()
    fail = False
    assert probe() == "ok"

    cb = cb_mod._circuit_breakers["A.probe"]
    assert cb.failure_threshold == 1
    fail = True
    with pytest.raises(RuntimeError):
        probe()
    assert cb.state == CircuitState.OPEN
    cb.reset()
    fail = False
    assert probe() == "ok"


async def test_clear_resets_decorated_async_methods() -> None:
    fail = True

    @circuit_breaker(name="A.aprobe", failure_threshold=1, recovery_timeout_ms=60_000)
    async def probe() -> str:
        if fail:
            raise RuntimeError("down")
        return "ok"

    with pytest.raises(RuntimeError):
        await probe()
    with pytest.raises(CircuitBreakerOpenError):
        await probe()
    clear_circuit_breakers()
    fail = False
    assert await probe() == "ok"


def test_late_result_from_abandoned_probe_is_discarded_after_reclaim() -> None:
    cb = CircuitBreaker(
        failure_threshold=1,
        recovery_timeout_ms=30,
        half_open_success_threshold=1,
    )
    epoch = cb.acquire()
    assert epoch is not None
    cb.record_failure(epoch)
    assert cb.state == CircuitState.OPEN
    time.sleep(0.04)
    assert cb.state == CircuitState.HALF_OPEN
    a = cb.acquire()
    assert a is not None
    time.sleep(0.04)
    b = cb.acquire()
    assert b is not None
    assert a != b
    cb.record_success(a)
    assert cb.state == CircuitState.HALF_OPEN
    cb.record_failure(a)
    assert cb.state == CircuitState.HALF_OPEN
    cb.record_success(b)
    assert cb.state == CircuitState.CLOSED


async def test_cancelled_async_probe_releases_its_slot() -> None:
    started = asyncio.Event()
    gate = asyncio.Event()
    mode = "fail"

    @circuit_breaker(
        name="cancel-probe",
        failure_threshold=1,
        recovery_timeout_ms=200,
        half_open_success_threshold=1,
    )
    async def call() -> str:
        if mode == "fail":
            raise RuntimeError("down")
        if mode == "cancel":
            started.set()
            await gate.wait()
        return "ok"

    with pytest.raises(RuntimeError):
        await call()

    cb = get_circuit_breaker("cancel-probe")
    assert cb.state == CircuitState.OPEN

    await asyncio.sleep(0.22)
    assert cb.state == CircuitState.HALF_OPEN

    mode = "cancel"
    task = asyncio.create_task(call())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert cb.state == CircuitState.HALF_OPEN

    mode = "ok"
    res = await call()
    assert res == "ok"
    assert cb.state == CircuitState.CLOSED


def test_base_exception_in_sync_probe_releases_its_slot() -> None:
    class Abort(BaseException):
        pass

    fallback_called = False

    def fallback(exc: BaseException, *args: Any, **kwargs: Any) -> str:
        nonlocal fallback_called
        fallback_called = True
        return "fallback"

    mode = "abort"

    @circuit_breaker(
        name="sync-abort-probe",
        failure_threshold=1,
        recovery_timeout_ms=200,
        half_open_success_threshold=1,
        fallback=fallback,
    )
    def call() -> str:
        if mode == "abort":
            raise Abort()
        return "ok"

    cb = get_circuit_breaker("sync-abort-probe")
    epoch = cb.acquire()
    assert epoch is not None
    cb.record_failure(epoch)
    assert cb.state == CircuitState.OPEN

    time.sleep(0.22)
    assert cb.state == CircuitState.HALF_OPEN

    with pytest.raises(Abort):
        call()

    assert not fallback_called
    assert cb.state == CircuitState.HALF_OPEN

    mode = "ok"
    assert call() == "ok"
    assert not fallback_called
    assert cb.state == CircuitState.CLOSED


def test_unpaired_manual_success_cannot_close_half_open_breaker() -> None:
    cb = CircuitBreaker(
        failure_threshold=1,
        recovery_timeout_ms=30,
        half_open_success_threshold=1,
    )
    assert cb.allow_request()
    cb.record_failure()
    assert cb.state == CircuitState.OPEN
    time.sleep(0.04)
    assert cb.state == CircuitState.HALF_OPEN
    cb.record_success()
    assert cb.state == CircuitState.HALF_OPEN
    assert cb.allow_request()
    cb.record_success()
    assert cb.state == CircuitState.CLOSED


def test_half_open_record_success_without_epoch_ignored_unless_probe_admitted() -> None:
    cb = CircuitBreaker(
        failure_threshold=1,
        recovery_timeout_ms=10,
        half_open_success_threshold=1,
    )
    assert cb.allow_request()
    cb.record_failure()
    assert cb.state == CircuitState.OPEN
    time.sleep(0.02)
    assert cb.state == CircuitState.HALF_OPEN

    # In HALF_OPEN without acquire/allow_request, record_success is ignored.
    cb.record_success()
    assert cb.state == CircuitState.HALF_OPEN

    # In HALF_OPEN after allow_request returns True, record_success closes circuit.
    assert cb.allow_request() is True
    cb.record_success()
    assert cb.state == CircuitState.CLOSED


def test_warns_when_rate_limit_bucket_reused_with_different_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    warnings: list[str] = []

    class _Capture:
        def debug(self, msg: object) -> None: ...
        def info(self, msg: object) -> None: ...
        def warn(self, msg: object) -> None:
            warnings.append(str(msg))

        def error(self, msg: object) -> None: ...

    monkeypatch.setattr(logger_mod, "global_logger", _Capture())

    def fn1() -> str:
        return "1"

    fn1.__qualname__ = "SharedSvc.get"
    f1 = rate_limit(capacity=1, refill_rate=0.001)(fn1)

    def fn2() -> str:
        return "2"

    fn2.__qualname__ = "SharedSvc.get"
    f2 = rate_limit(capacity=100, refill_rate=0.001)(fn2)

    assert f1() == "1"
    assert warnings == []

    with pytest.raises(RateLimitExceededError):
        f2()

    assert len(warnings) == 1
    assert "already registered with different options" in warnings[0]

    with pytest.raises(RateLimitExceededError):
        f2()

    assert len(warnings) == 1

    # Negative assertion: two decorators with identical options sharing a key log nothing.
    clear_rate_limiters()
    warnings.clear()

    def fn3() -> str:
        return "3"

    fn3.__qualname__ = "IdenticalSvc.get"
    f3 = rate_limit(capacity=10, refill_rate=1.0)(fn3)

    def fn4() -> str:
        return "4"

    fn4.__qualname__ = "IdenticalSvc.get"
    f4 = rate_limit(capacity=10, refill_rate=1.0)(fn4)

    assert f3() == "3"
    assert f4() == "4"
    assert warnings == []


def test_rate_limit_warns_once_per_mismatched_bucket_with_key_extractor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from server_decorator.decorators._qualname import shorten_qualname
    from server_decorator.decorators.rate_limit import get_token_bucket

    warnings: list[str] = []

    class _Capture:
        def debug(self, msg: object) -> None: ...
        def info(self, msg: object) -> None: ...
        def warn(self, msg: object) -> None:
            warnings.append(str(msg))

        def error(self, msg: object) -> None: ...

    monkeypatch.setattr(logger_mod, "global_logger", _Capture())

    def target(key: str) -> str:
        return key

    target.__qualname__ = "DynamicSvc.query"
    base_key = shorten_qualname(target.__qualname__)

    get_token_bucket(f"{base_key}:a", 1.0, 1.0)
    get_token_bucket(f"{base_key}:b", 1.0, 1.0)

    decorated = rate_limit(
        capacity=10.0,
        refill_rate=5.0,
        key_extractor=lambda key: key,
    )(target)

    decorated("a")
    with pytest.raises(RateLimitExceededError):
        decorated("a")
    decorated("b")

    assert len(warnings) == 2
    assert f"bucket '{base_key}:a' is already registered with different options" in warnings[0]
    assert f"bucket '{base_key}:b' is already registered with different options" in warnings[1]


def test_warns_when_cleared_registry_is_repopulated_with_other_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    warnings: list[str] = []

    class _Capture:
        def debug(self, msg: object) -> None: ...
        def info(self, msg: object) -> None: ...
        def warn(self, msg: object) -> None:
            warnings.append(str(msg))

        def error(self, msg: object) -> None: ...

    monkeypatch.setattr(logger_mod, "global_logger", _Capture())

    @circuit_breaker(name="A.probe", failure_threshold=1, recovery_timeout_ms=10_000)
    def probe() -> str:
        return "ok"

    assert warnings == []

    clear_circuit_breakers()
    get_circuit_breaker("A.probe")

    assert probe() == "ok"
    assert probe() == "ok"

    assert len(warnings) == 1
    assert "already registered with different options" in warnings[0]


def test_static_methods_of_different_classes_get_separate_breakers_and_buckets() -> None:
    class A:
        @staticmethod
        @circuit_breaker(failure_threshold=1)
        def run() -> None:
            raise RuntimeError("fail")

        @staticmethod
        @rate_limit(capacity=1, refill_rate=0.001)
        def hit() -> str:
            return "a_hit"

    class B:
        @staticmethod
        @circuit_breaker(failure_threshold=1)
        def run() -> str:
            return "b_run"

        @staticmethod
        @rate_limit(capacity=1, refill_rate=0.001)
        def hit() -> str:
            return "b_hit"

    # Tripping A.run leaves B.run callable
    with pytest.raises(RuntimeError):
        A.run()
    with pytest.raises(CircuitBreakerOpenError):
        A.run()
    assert B.run() == "b_run"

    # Draining A.hit leaves B.hit callable
    assert A.hit() == "a_hit"
    with pytest.raises(RateLimitExceededError):
        A.hit()
    assert B.hit() == "b_hit"

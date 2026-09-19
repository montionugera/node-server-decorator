import time
import pytest

from server_decorator import (
    CircuitBreakerOpenError,
    CircuitState,
    circuit_breaker,
    circuit_breaker_class,
    clear_circuit_breakers,
    get_circuit_breaker,
)


@pytest.fixture(autouse=True)
def clean_registry():
    clear_circuit_breakers()
    yield
    clear_circuit_breakers()


def test_circuit_breaker_state_transitions():
    cb = get_circuit_breaker(
        "test-svc",
        failure_threshold=2,
        recovery_timeout_ms=50.0,
        half_open_success_threshold=2,
    )
    assert cb.state == CircuitState.CLOSED

    cb.record_failure()
    assert cb.state == CircuitState.CLOSED

    cb.record_failure()
    assert cb.state == CircuitState.OPEN
    assert not cb.allow_request()

    time.sleep(0.06)
    assert cb.state == CircuitState.HALF_OPEN
    assert cb.allow_request()

    cb.record_success()
    assert cb.state == CircuitState.HALF_OPEN

    cb.record_success()
    assert cb.state == CircuitState.CLOSED


def test_circuit_breaker_decorator_sync():
    calls = 0

    @circuit_breaker(
        name="sync-breaker",
        failure_threshold=2,
        recovery_timeout_ms=50.0,
    )
    def dangerous():
        nonlocal calls
        calls += 1
        raise ConnectionResetError("boom")

    with pytest.raises(ConnectionResetError):
        dangerous()

    with pytest.raises(ConnectionResetError):
        dangerous()

    # Third call trips immediately with CircuitBreakerOpenError without calling dangerous()
    before = calls
    with pytest.raises(CircuitBreakerOpenError):
        dangerous()
    assert calls == before


def test_circuit_breaker_fallback():
    @circuit_breaker(
        name="fallback-breaker",
        failure_threshold=1,
        fallback=lambda err, *args: f"fallback-{args[0]}",
    )
    def fetch_user(user_id: str) -> str:
        raise RuntimeError("db error")

    assert fetch_user("123") == "fallback-123"
    # Open state also triggers fallback
    assert fetch_user("456") == "fallback-456"


@pytest.mark.asyncio
async def test_circuit_breaker_async():
    calls = 0

    @circuit_breaker(name="async-breaker", failure_threshold=1)
    async def async_call():
        nonlocal calls
        calls += 1
        raise TimeoutError("timeout")

    with pytest.raises(TimeoutError):
        await async_call()

    with pytest.raises(CircuitBreakerOpenError):
        await async_call()
    assert calls == 1


def test_circuit_breaker_class():
    class Api:
        def get_data(self):
            raise RuntimeError("down")

    Wrapped = circuit_breaker_class(name="api-breaker", failure_threshold=1)(Api)
    api = Wrapped()

    with pytest.raises(RuntimeError):
        api.get_data()

    with pytest.raises(CircuitBreakerOpenError):
        api.get_data()

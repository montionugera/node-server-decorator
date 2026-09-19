import pytest

from server_decorator import retry, retry_class


def test_retry_sync_success_first_attempt():
    calls = 0

    @retry(max_attempts=3, backoff_ms=5)
    def compute(x: int) -> int:
        nonlocal calls
        calls += 1
        return x * 2

    assert compute(5) == 10
    assert calls == 1


def test_retry_sync_success_after_failures():
    calls = 0

    @retry(max_attempts=4, backoff_ms=5, jitter=False)
    def flaky() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ValueError("temporary error")
        return "success"

    assert flaky() == "success"
    assert calls == 3


def test_retry_sync_exhaust_attempts():
    calls = 0

    @retry(max_attempts=3, backoff_ms=2, jitter=False)
    def failing() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("fatal")

    with pytest.raises(RuntimeError, match="fatal"):
        failing()
    assert calls == 3


def test_retry_sync_predicate():
    calls = 0

    @retry(
        max_attempts=3,
        backoff_ms=5,
        retry_if=lambda e: "retryable" in str(e),
    )
    def pred_fn(msg: str) -> None:
        nonlocal calls
        calls += 1
        raise ValueError(msg)

    with pytest.raises(ValueError, match="fatal error"):
        pred_fn("fatal error")
    assert calls == 1


@pytest.mark.asyncio
async def test_retry_async_success_after_failures():
    calls = 0

    @retry(max_attempts=3, backoff_ms=5, jitter=False)
    async def async_flaky() -> str:
        nonlocal calls
        calls += 1
        if calls < 2:
            raise ConnectionError("down")
        return "connected"

    assert await async_flaky() == "connected"
    assert calls == 2


def test_retry_class():
    class Service:
        def __init__(self):
            self.calls = 0

        def run(self) -> str:
            self.calls += 1
            if self.calls < 2:
                raise RuntimeError("try again")
            return "done"

    WrappedService = retry_class(max_attempts=3, backoff_ms=5, jitter=False)(Service)
    s = WrappedService()
    assert s.run() == "done"
    assert s.calls == 2

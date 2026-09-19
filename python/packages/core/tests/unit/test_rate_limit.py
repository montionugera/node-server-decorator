import time

import pytest

from server_decorator import (
    RateLimitExceededError,
    clear_rate_limiters,
    rate_limit,
    rate_limit_class,
)


@pytest.fixture(autouse=True)
def clean_registry():
    clear_rate_limiters()
    yield
    clear_rate_limiters()


def test_rate_limit_sync():
    calls = 0

    @rate_limit(capacity=2, refill_rate=10.0)
    def ping() -> str:
        nonlocal calls
        calls += 1
        return "pong"

    assert ping() == "pong"
    assert ping() == "pong"

    with pytest.raises(RateLimitExceededError):
        ping()

    # Wait 120ms for refill
    time.sleep(0.12)
    assert ping() == "pong"


def test_rate_limit_key_extractor():
    @rate_limit(
        capacity=1,
        refill_rate=1.0,
        key_extractor=lambda user_id: str(user_id),
    )
    def do_action(user_id: str) -> str:
        return f"done-{user_id}"

    assert do_action("alice") == "done-alice"
    with pytest.raises(RateLimitExceededError):
        do_action("alice")

    # Bob has separate bucket
    assert do_action("bob") == "done-bob"


@pytest.mark.asyncio
async def test_rate_limit_async():
    @rate_limit(capacity=1, refill_rate=10.0)
    async def async_op():
        return "ok"

    assert await async_op() == "ok"
    with pytest.raises(RateLimitExceededError):
        await async_op()


def test_rate_limit_class():
    class Svc:
        def invoke(self):
            return "invoked"

    wrapped_svc_cls = rate_limit_class(capacity=1, refill_rate=1.0)(Svc)
    s = wrapped_svc_cls()
    assert s.invoke() == "invoked"
    with pytest.raises(RateLimitExceededError):
        s.invoke()

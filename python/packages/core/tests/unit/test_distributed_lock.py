"""Unit tests for @distributed_lock and @distributed_lock_class."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from server_decorator.decorators.distributed_lock import (
    RELEASE_LOCK_LUA,
    RENEW_LOCK_LUA,
    LockAcquisitionError,
    clear_global_distributed_lock_adapter,
    distributed_lock,
    distributed_lock_class,
)


class MockRedisLockAdapter:
    def __init__(self) -> None:
        self.store: dict[str, tuple[str, float]] = {}
        self.set_nx_calls = 0
        self.eval_lua_calls = 0

    async def set_nx_px(self, key: str, value: str, ttl_ms: int) -> bool:
        self.set_nx_calls += 1
        now = time.monotonic()
        if key in self.store:
            _, expires_at = self.store[key]
            if expires_at > now:
                return False
        expires_at = now + (ttl_ms / 1000.0)
        self.store[key] = (value, expires_at)
        return True

    async def eval_lua(self, script: str, keys: list[str], args: list[Any]) -> Any:
        self.eval_lua_calls += 1
        key = keys[0]
        now = time.monotonic()

        if script == RELEASE_LOCK_LUA:
            token = str(args[0])
            if key in self.store:
                held_token, expires_at = self.store[key]
                if held_token == token and expires_at > now:
                    del self.store[key]
                    return 1
            return 0

        if script == RENEW_LOCK_LUA:
            token = str(args[0])
            ttl_ms = float(args[1])
            if key in self.store:
                held_token, expires_at = self.store[key]
                if held_token == token and expires_at > now:
                    self.store[key] = (held_token, now + (ttl_ms / 1000.0))
                    return 1
            return 0

        return None


@pytest.fixture(autouse=True)
def cleanup_adapter() -> Any:
    clear_global_distributed_lock_adapter()
    yield
    clear_global_distributed_lock_adapter()


@pytest.mark.asyncio
async def test_distributed_lock_acquire_and_safe_release() -> None:
    adapter = MockRedisLockAdapter()

    class PaymentService:
        @distributed_lock(
            key=lambda self, order_id, amount: f"lock:order:{order_id}",
            ttl_seconds=5.0,
            adapter=adapter,
        )
        async def process_payment(self, order_id: str, amount: float) -> str:
            assert f"lock:order:{order_id}" in adapter.store
            return f"Paid {amount} for {order_id}"

    svc = PaymentService()
    res = await svc.process_payment("ord-123", 99.5)
    assert res == "Paid 99.5 for ord-123"
    assert "lock:order:ord-123" not in adapter.store


@pytest.mark.asyncio
async def test_distributed_lock_contention_raises_error() -> None:
    adapter = MockRedisLockAdapter()

    class InventoryService:
        @distributed_lock(
            key="lock:stock:item-1",
            ttl_seconds=5.0,
            wait_timeout_seconds=0.0,
            adapter=adapter,
        )
        async def reserve(self, delay: float) -> str:
            await asyncio.sleep(delay)
            return "reserved"

    svc = InventoryService()
    t1 = asyncio.create_task(svc.reserve(0.05))
    await asyncio.sleep(0.01)

    with pytest.raises(LockAcquisitionError):
        await svc.reserve(0.01)

    assert await t1 == "reserved"


@pytest.mark.asyncio
async def test_distributed_lock_fallback_on_timeout() -> None:
    adapter = MockRedisLockAdapter()

    class JobService:
        @distributed_lock(
            key="lock:cron",
            ttl_seconds=5.0,
            wait_timeout_seconds=0.02,
            fallback=lambda self, delay: "fallback_executed",
            adapter=adapter,
        )
        async def run_job(self, delay: float) -> str:
            await asyncio.sleep(delay)
            return "job_done"

    svc = JobService()
    t1 = asyncio.create_task(svc.run_job(0.08))
    await asyncio.sleep(0.01)

    res = await svc.run_job(0.01)
    assert res == "fallback_executed"
    assert await t1 == "job_done"


@pytest.mark.asyncio
async def test_distributed_lock_mutual_exclusion_concurrency() -> None:
    adapter = MockRedisLockAdapter()
    concurrent_count = 0
    max_concurrent = 0

    class CriticalService:
        @distributed_lock(
            key="lock:critical",
            ttl_seconds=5.0,
            wait_timeout_seconds=1.0,
            retry_interval_seconds=0.01,
            adapter=adapter,
        )
        async def do_critical(self, idx: int) -> int:
            nonlocal concurrent_count, max_concurrent
            concurrent_count += 1
            if concurrent_count > max_concurrent:
                max_concurrent = concurrent_count
            await asyncio.sleep(0.01)
            concurrent_count -= 1
            return idx

    svc = CriticalService()
    tasks = [svc.do_critical(i) for i in range(15)]
    results = await asyncio.gather(*tasks)

    assert len(results) == 15
    assert max_concurrent == 1  # STRICT MUTUAL EXCLUSION
    assert concurrent_count == 0


@pytest.mark.asyncio
async def test_distributed_lock_watchdog_auto_renewal() -> None:
    adapter = MockRedisLockAdapter()

    class LongTaskService:
        @distributed_lock(
            key="lock:long",
            ttl_seconds=0.06,  # 60ms TTL, watchdog renews every ~20ms
            auto_renew=True,
            adapter=adapter,
        )
        async def long_task(self) -> str:
            await asyncio.sleep(0.12)  # Runs 2x longer than initial TTL
            assert "lock:long" in adapter.store
            _held_token, expires_at = adapter.store["lock:long"]
            assert expires_at > time.monotonic()
            return "completed"

    svc = LongTaskService()
    res = await svc.long_task()
    assert res == "completed"
    assert "lock:long" not in adapter.store


@pytest.mark.asyncio
async def test_distributed_lock_class_decorator() -> None:
    adapter = MockRedisLockAdapter()

    @distributed_lock_class(key_prefix="class_lock", ttl_seconds=2.0, adapter=adapter)
    class MultiMethodService:
        async def method_a(self) -> str:
            assert "class_lock:MultiMethodService:method_a" in adapter.store
            return "a"

        async def method_b(self) -> str:
            assert "class_lock:MultiMethodService:method_b" in adapter.store
            return "b"

    svc = MultiMethodService()
    assert await svc.method_a() == "a"
    assert "class_lock:MultiMethodService:method_a" not in adapter.store
    assert await svc.method_b() == "b"
    assert "class_lock:MultiMethodService:method_b" not in adapter.store

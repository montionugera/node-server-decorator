"""Unit coverage for distributed_lock.py using an in-memory fake RedisLockAdapter."""

from __future__ import annotations

import asyncio
import importlib
from collections.abc import Iterator
from typing import Any

import pytest

dl_mod = importlib.import_module("server_decorator.decorators.distributed_lock")
LockAcquisitionError = dl_mod.LockAcquisitionError
LockLostError = dl_mod.LockLostError
RELEASE_LOCK_LUA = dl_mod.RELEASE_LOCK_LUA
RENEW_LOCK_LUA = dl_mod.RENEW_LOCK_LUA
clear_global_distributed_lock_adapter = dl_mod.clear_global_distributed_lock_adapter
configure_distributed_lock = dl_mod.configure_distributed_lock
distributed_lock = dl_mod.distributed_lock
distributed_lock_class = dl_mod.distributed_lock_class
get_global_distributed_lock_adapter = dl_mod.get_global_distributed_lock_adapter


_UNSET = object()


class FakeLockAdapter:
    """Minimal single-node Redis stand-in implementing the two Lua scripts' semantics."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.set_calls: list[tuple[str, str, int]] = []
        self.evals: list[tuple[str, list[str], list[Any]]] = []
        self.fail_acquire_times = 0
        self.renew_result: Any = 1
        self.renew_error: Exception | None = None
        self.release_error: Exception | None = None
        self.release_result: Any = _UNSET
        self.release_block: asyncio.Event | None = None
        self.release_entered: asyncio.Event | None = None
        self.renew_count = 0
        self._renew_seen = asyncio.Event()

    async def wait_for_renews(self, n: int) -> None:
        """Block until the watchdog has issued at least `n` renewals (event-driven, no sleeps)."""

        async def _wait() -> None:
            while self.renew_count < n:
                self._renew_seen.clear()
                await self._renew_seen.wait()

        await asyncio.wait_for(_wait(), 5)

    async def set_nx_px(self, key: str, value: str, ttl_ms: int) -> bool:
        self.set_calls.append((key, value, ttl_ms))
        if self.fail_acquire_times > 0:
            self.fail_acquire_times -= 1
            return False
        if key in self.store:
            return False
        self.store[key] = value
        return True

    async def eval_lua(self, script: str, keys: list[str], args: list[Any]) -> Any:
        self.evals.append((script, keys, args))
        if script == RENEW_LOCK_LUA:
            self.renew_count += 1
            self._renew_seen.set()
            if self.renew_error is not None:
                raise self.renew_error
            return self.renew_result
        if self.release_block is not None:
            if self.release_entered is not None:
                self.release_entered.set()
            await self.release_block.wait()
        if self.release_error is not None:
            raise self.release_error
        if self.release_result is not _UNSET:
            return self.release_result
        if self.store.get(keys[0]) == args[0]:
            del self.store[keys[0]]
            return 1
        return 0

    def scripts(self) -> list[str]:
        return ["renew" if s == RENEW_LOCK_LUA else "release" for s, _, _ in self.evals]


@pytest.fixture(autouse=True)
def _clean_global_adapter() -> Iterator[None]:
    clear_global_distributed_lock_adapter()
    yield
    clear_global_distributed_lock_adapter()


# --------------------------------------------------------------------- global adapter


def test_configure_get_and_clear_global_adapter() -> None:
    adapter = FakeLockAdapter()

    assert get_global_distributed_lock_adapter() is None
    configure_distributed_lock(adapter)
    assert get_global_distributed_lock_adapter() is adapter
    clear_global_distributed_lock_adapter()
    assert get_global_distributed_lock_adapter() is None


async def test_global_adapter_is_resolved_at_call_time() -> None:
    @distributed_lock("job", auto_renew=False)
    async def job() -> str:
        return "ran"

    with pytest.raises(RuntimeError, match="No RedisLockAdapter provided for method 'job'"):
        await job()

    adapter = FakeLockAdapter()
    configure_distributed_lock(adapter)

    assert await job() == "ran"
    assert adapter.set_calls[0][0] == "job"


async def test_explicit_adapter_wins_over_global() -> None:
    global_adapter, explicit = FakeLockAdapter(), FakeLockAdapter()
    configure_distributed_lock(global_adapter)

    @distributed_lock("k", auto_renew=False, adapter=explicit)
    async def job() -> int:
        return 1

    assert await job() == 1
    assert len(explicit.set_calls) == 1
    assert global_adapter.set_calls == []


def test_sync_function_is_rejected_at_decoration_time() -> None:
    def sync_job() -> None: ...

    with pytest.raises(TypeError, match="requires an async coroutine function"):
        distributed_lock("k", adapter=FakeLockAdapter())(sync_job)


# ------------------------------------------------------------------ acquire / release


async def test_lock_is_held_during_call_and_released_with_same_token() -> None:
    adapter = FakeLockAdapter()
    held: list[str | None] = []

    @distributed_lock("orders:1", ttl_seconds=2.5, auto_renew=False, adapter=adapter)
    async def job(x: int) -> int:
        held.append(adapter.store.get("orders:1"))
        return x * 2

    assert await job(21) == 42

    key, token, ttl_ms = adapter.set_calls[0]
    assert (key, ttl_ms) == ("orders:1", 2500)
    assert held == [token]
    assert adapter.evals == [(RELEASE_LOCK_LUA, ["orders:1"], [token])]
    assert adapter.store == {}
    assert job.__name__ == "job"


async def test_each_call_uses_a_fresh_token() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> None:
        return None

    await job()
    await job()

    tokens = [t for _, t, _ in adapter.set_calls]
    assert len(set(tokens)) == 2


async def test_callable_key_receives_call_arguments() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock(
        lambda user_id, *, tenant: f"lock:{tenant}:{user_id}", auto_renew=False, adapter=adapter
    )
    async def job(user_id: int, *, tenant: str) -> str:
        return "ok"

    assert await job(7, tenant="acme") == "ok"
    assert adapter.set_calls[0][0] == "lock:acme:7"


async def test_contention_without_wait_raises_and_never_runs_or_releases() -> None:
    adapter = FakeLockAdapter()
    adapter.store["k"] = "someone-else"
    ran = False

    @distributed_lock("k", adapter=adapter)
    async def job() -> None:
        nonlocal ran
        ran = True

    with pytest.raises(LockAcquisitionError, match=r"Failed to acquire lock for 'k' within 0.0s"):
        await job()

    assert ran is False
    assert len(adapter.set_calls) == 1
    assert adapter.evals == []
    assert adapter.store == {"k": "someone-else"}


async def test_contention_uses_sync_fallback_with_call_arguments() -> None:
    adapter = FakeLockAdapter()
    adapter.store["k"] = "other"

    @distributed_lock("k", adapter=adapter, fallback=lambda x, *, y: ("fallback", x, y))
    async def job(x: int, *, y: int) -> Any:
        return "real"

    assert await job(1, y=2) == ("fallback", 1, 2)
    assert adapter.evals == []


async def test_contention_awaits_async_fallback() -> None:
    adapter = FakeLockAdapter()
    adapter.store["k"] = "other"

    async def fallback(x: int) -> str:
        return f"async-fallback:{x}"

    @distributed_lock("k", adapter=adapter, fallback=fallback)
    async def job(x: int) -> str:
        return "real"

    assert await job(9) == "async-fallback:9"


async def test_waits_and_retries_until_lock_becomes_free() -> None:
    adapter = FakeLockAdapter()
    adapter.fail_acquire_times = 2

    @distributed_lock(
        "k",
        wait_timeout_seconds=2.0,
        retry_interval_seconds=0.01,
        auto_renew=False,
        adapter=adapter,
    )
    async def job() -> str:
        return "got it"

    assert await job() == "got it"
    assert len(adapter.set_calls) == 3
    # The same token is retried; a fresh one per attempt would break the guarded release.
    assert len({t for _, t, _ in adapter.set_calls}) == 1


async def test_wait_timeout_expires_into_acquisition_error() -> None:
    adapter = FakeLockAdapter()
    adapter.store["k"] = "other"

    @distributed_lock("k", wait_timeout_seconds=0.05, retry_interval_seconds=0.01, adapter=adapter)
    async def job() -> None: ...

    with pytest.raises(LockAcquisitionError, match=r"within 0\.05s"):
        await job()

    assert len(adapter.set_calls) >= 2
    assert adapter.store == {"k": "other"}


async def test_release_failure_is_swallowed_and_result_returned() -> None:
    adapter = FakeLockAdapter()
    adapter.release_error = ConnectionError("redis gone")

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> str:
        return "done"

    assert await job() == "done"
    assert adapter.scripts() == ["release"]


async def test_function_error_propagates_and_lock_is_still_released() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> None:
        raise ValueError("business failure")

    with pytest.raises(ValueError, match="business failure"):
        await job()

    assert adapter.scripts() == ["release"]
    assert adapter.store == {}


async def test_function_error_survives_release_failure() -> None:
    adapter = FakeLockAdapter()
    adapter.release_error = ConnectionError("redis gone")

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> None:
        raise ValueError("business failure")

    with pytest.raises(ValueError, match="business failure"):
        await job()


# ----------------------------------------------------------------------------- renewal


async def test_auto_renew_false_never_sends_a_renewal() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", ttl_seconds=0.03, auto_renew=False, adapter=adapter)
    async def job() -> str:
        await asyncio.sleep(0.1)
        return "ok"

    assert await job() == "ok"
    assert adapter.scripts() == ["release"]


async def test_auto_renew_extends_with_token_and_ttl_then_releases() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> str:
        await asyncio.sleep(0.09)
        return "ok"

    assert await job() == "ok"

    token = adapter.set_calls[0][1]
    scripts = adapter.scripts()
    assert scripts[-1] == "release"
    assert scripts.count("renew") >= 1
    assert adapter.evals[0] == (RENEW_LOCK_LUA, ["k"], [token, 60])
    assert adapter.store == {}


async def test_fast_call_finishes_before_first_renewal() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", ttl_seconds=30.0, adapter=adapter)
    async def job() -> str:
        return "ok"

    assert await job() == "ok"
    assert adapter.scripts() == ["release"]


@pytest.mark.parametrize("renew_result", [0, None, False])
async def test_renewal_reporting_lease_gone_raises_lock_lost_after_call(renew_result: Any) -> None:
    adapter = FakeLockAdapter()
    adapter.renew_result = renew_result
    finished = False

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> str:
        nonlocal finished
        await asyncio.sleep(0.08)
        finished = True
        return "unsafe result"

    with pytest.raises(LockLostError, match="Lock for 'k' was lost while 'job' was running"):
        await job()

    # The body is allowed to settle; the watchdog stops after the first lost renewal.
    assert finished is True
    assert adapter.scripts() == ["renew", "release"]


async def test_lock_lost_replaces_the_function_error() -> None:
    adapter = FakeLockAdapter()
    adapter.renew_result = 0

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> None:
        await asyncio.sleep(0.08)
        raise ValueError("business failure")

    with pytest.raises(LockLostError) as excinfo:
        await job()

    assert isinstance(excinfo.value.__context__, ValueError)


async def test_transient_renewal_error_is_retried_not_treated_as_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.renew_error = ConnectionError("blip")

    # ttl 0.6s -> renew every 0.2s; the body waits on the renewals themselves, so the
    # failed first renewal and the successful second one are both observed, not raced.
    @distributed_lock("k", ttl_seconds=0.6, adapter=adapter)
    async def job() -> str:
        await adapter.wait_for_renews(1)
        adapter.renew_error = None
        await adapter.wait_for_renews(2)
        return "ok"

    assert await job() == "ok"
    assert adapter.scripts().count("renew") == 2
    assert adapter.scripts()[-1] == "release"


async def test_renewals_failing_for_a_full_ttl_raise_lock_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.renew_error = ConnectionError("redis partitioned")

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> str:
        await asyncio.sleep(0.2)
        return "unsafe"

    with pytest.raises(LockLostError):
        await job()

    assert adapter.scripts().count("renew") >= 2
    assert adapter.scripts()[-1] == "release"


async def test_cancellation_propagates_and_releases_even_when_lease_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.renew_result = 0
    started = asyncio.Event()

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> None:
        started.set()
        await asyncio.sleep(10)

    task = asyncio.create_task(job())
    await started.wait()
    await adapter.wait_for_renews(1)  # the watchdog has observed the lost lease
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert adapter.scripts() == ["renew", "release"]
    assert adapter.store == {}


async def test_lock_lost_is_reported_when_awaited_inside_a_base_exception_handler() -> None:
    # A caller running cleanup inside `except BaseException` must still see a lost lease:
    # the caller's in-flight exception is not the wrapper's own outcome.
    class OuterInterrupt(BaseException):
        pass

    adapter = FakeLockAdapter()
    adapter.renew_result = 0

    @distributed_lock("k", ttl_seconds=0.06, adapter=adapter)
    async def job() -> str:
        await adapter.wait_for_renews(1)
        return "unsafe result"

    try:
        raise OuterInterrupt
    except OuterInterrupt:
        with pytest.raises(LockLostError):
            await job()

    assert adapter.scripts() == ["renew", "release"]


# -------------------------------------------------------------------------- class form


async def test_class_form_locks_async_methods_and_skips_sync_ones() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock_class("jobs", auto_renew=False, adapter=adapter, exclude=("excluded",))
    class Worker:
        async def run(self, n: int) -> int:
            return n + 1

        async def excluded(self) -> str:
            return "unlocked"

        def describe(self) -> str:
            return "sync"

        async def _internal(self) -> str:
            return "private"

    w = Worker()

    assert await w.run(1) == 2
    assert [c[0] for c in adapter.set_calls] == ["jobs:Worker:run"]

    assert w.describe() == "sync"
    assert await w.excluded() == "unlocked"
    assert await w._internal() == "private"
    assert len(adapter.set_calls) == 1


async def test_class_form_default_prefix_and_contention_fallback() -> None:
    adapter = FakeLockAdapter()
    adapter.store["lock:Worker:run"] = "other"

    @distributed_lock_class(adapter=adapter, fallback=lambda self: "busy")
    class Worker:
        async def run(self) -> str:
            return "ran"

    assert await Worker().run() == "busy"
    assert adapter.set_calls[0][0] == "lock:Worker:run"


# -------------------------------------------------------- release loss / cancellation


async def test_auto_renew_off_takeover_seen_only_at_release_raises_lock_lost() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> str:
        adapter.store["k"] = "other-owner"
        return "ok"

    with pytest.raises(LockLostError, match="Lock for 'k' was lost while 'job' was running"):
        await job()

    assert adapter.store.get("k") == "other-owner"
    assert adapter.scripts() == ["release"]


async def test_release_returning_zero_raises_lock_lost_even_if_no_renewal_saw_it() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", ttl_seconds=30.0, auto_renew=True, adapter=adapter)
    async def job() -> str:
        adapter.store["k"] = "other-owner"
        return "ok"

    with pytest.raises(LockLostError, match="Lock for 'k' was lost while 'job' was running"):
        await job()

    assert adapter.scripts() == ["release"]


async def test_release_reported_loss_keeps_function_error_as_context() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> None:
        adapter.store["k"] = "other-owner"
        raise ValueError("boom")

    with pytest.raises(LockLostError) as excinfo:
        await job()

    assert isinstance(excinfo.value.__context__, ValueError)
    assert str(excinfo.value.__context__) == "boom"


async def test_release_error_after_full_ttl_raises_lock_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.release_error = ConnectionError("redis down")

    @distributed_lock("k", ttl_seconds=0.03, auto_renew=False, adapter=adapter)
    async def job() -> str:
        await asyncio.sleep(0.06)
        return "ok"

    with pytest.raises(LockLostError):
        await job()

    assert adapter.scripts() == ["release"]


async def test_release_error_within_ttl_still_returns_result() -> None:
    adapter = FakeLockAdapter()
    adapter.release_error = ConnectionError("redis blip")

    @distributed_lock("k", ttl_seconds=10.0, auto_renew=False, adapter=adapter)
    async def job() -> str:
        return "ok"

    assert await job() == "ok"
    assert adapter.scripts() == ["release"]


async def test_release_returning_none_is_not_treated_as_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.release_result = None

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> str:
        return "ok"

    assert await job() == "ok"
    assert adapter.scripts() == ["release"]


async def test_cancellation_during_release_is_not_replaced_by_lock_lost() -> None:
    adapter = FakeLockAdapter()
    adapter.renew_result = 0
    adapter.release_block = asyncio.Event()
    adapter.release_entered = asyncio.Event()

    @distributed_lock("k", ttl_seconds=0.06, auto_renew=True, adapter=adapter)
    async def job() -> str:
        await adapter.wait_for_renews(1)
        return "ok"

    task = asyncio.create_task(job())
    await adapter.release_entered.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert task.cancelled() is True
    assert "release" in adapter.scripts()


async def test_cancellation_during_watchdog_stop_is_not_replaced_by_lock_lost() -> None:
    adapter = FakeLockAdapter()

    @distributed_lock("k", ttl_seconds=10.0, auto_renew=True, adapter=adapter)
    async def job() -> str:
        adapter.store["k"] = "other-owner"
        cur = asyncio.current_task()
        assert cur is not None
        asyncio.get_running_loop().call_soon(cur.cancel)
        return "ok"

    task = asyncio.create_task(job())

    with pytest.raises(asyncio.CancelledError):
        await task

    assert task.cancelled() is True
    assert "release" in adapter.scripts()


async def test_cancelled_function_with_release_returning_zero_stays_cancelled() -> None:
    adapter = FakeLockAdapter()
    started = asyncio.Event()

    @distributed_lock("k", auto_renew=False, adapter=adapter)
    async def job() -> str:
        adapter.store["k"] = "other-owner"
        started.set()
        await asyncio.sleep(10)
        return "ok"

    task = asyncio.create_task(job())
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert task.cancelled() is True
    assert adapter.scripts() == ["release"]

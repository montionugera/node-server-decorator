"""Unit tests for SingleFlight (keyed single-flight for asyncio)."""

from __future__ import annotations

import asyncio
import contextvars
import gc
from typing import Any

import pytest

from server_decorator import SingleFlight

KEY = ("x", "m30", "2020-Q1")


async def _settle() -> None:
    """Let every task that is ready to run take a few steps."""
    for _ in range(5):
        await asyncio.sleep(0)


class _Work:
    """A fetcher that blocks on a gate and records what happened to it."""

    def __init__(self, result: Any = None) -> None:
        self.calls = 0
        self.cancelled = 0
        self.gate = asyncio.Event()
        self.result = ["row"] if result is None else result

    async def __call__(self) -> Any:
        self.calls += 1
        try:
            await self.gate.wait()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        return self.result


# --- ported from quant TestFetchOrWait ------------------------------------------------------


async def test_single_caller_runs_fetcher_once() -> None:
    sf: SingleFlight[tuple[str, str, str], list[str]] = SingleFlight()
    call_count = 0

    async def fetcher() -> list[str]:
        nonlocal call_count
        call_count += 1
        return ["row"]

    rows = await sf.do(KEY, fetcher)
    assert rows == ["row"]
    assert call_count == 1


async def test_concurrent_callers_share_one_fetch() -> None:
    sf: SingleFlight[tuple[str, str, str], list[str]] = SingleFlight()
    work = _Work()

    tasks = [asyncio.create_task(sf.do(KEY, work)) for _ in range(3)]
    await _settle()
    work.gate.set()
    results = await asyncio.gather(*tasks)
    assert results == [["row"], ["row"], ["row"]]
    assert work.calls == 1


async def test_inflight_cleanup_after_completion() -> None:
    sf: SingleFlight[tuple[str, str, str], list[str]] = SingleFlight()

    async def fetcher() -> list[str]:
        return ["row"]

    await sf.do(KEY, fetcher)
    assert len(sf) == 0


async def test_exception_propagates_to_all_waiters() -> None:
    sf: SingleFlight[tuple[str, str, str], list[str]] = SingleFlight()
    gate = asyncio.Event()

    async def failing_fetcher() -> list[str]:
        await gate.wait()
        raise RuntimeError("PG down")

    t1 = asyncio.create_task(sf.do(KEY, failing_fetcher))
    t2 = asyncio.create_task(sf.do(KEY, failing_fetcher))
    await _settle()
    gate.set()
    with pytest.raises(RuntimeError, match="PG down"):
        await t1
    with pytest.raises(RuntimeError, match="PG down"):
        await t2
    assert len(sf) == 0


# --- sharing --------------------------------------------------------------------------------


async def test_callers_share_result_identity() -> None:
    sf: SingleFlight[str, list[str]] = SingleFlight()
    result = ["row"]
    work = _Work(result)

    tasks = [asyncio.create_task(sf.do("k", work)) for _ in range(3)]
    await _settle()
    work.gate.set()
    first, second, third = await asyncio.gather(*tasks)

    assert first is result and second is result and third is result
    first.append("mutated")
    assert third == ["row", "mutated"]


async def test_tuple_key_runs_once_and_other_keys_run_separately() -> None:
    sf: SingleFlight[tuple[str, str, str], str] = SingleFlight()
    same, other = _Work("same"), _Work("other")

    tasks = [
        asyncio.create_task(sf.do(("x", "m30", "2020-Q1"), same)),
        asyncio.create_task(sf.do(("x", "m30", "2020-Q1"), same)),
        asyncio.create_task(sf.do(("x", "m30", "2020-Q2"), other)),
    ]
    await _settle()
    assert len(sf) == 2
    same.gate.set()
    other.gate.set()

    assert await asyncio.gather(*tasks) == ["same", "same", "other"]
    assert (same.calls, other.calls) == (1, 1)


async def test_registration_is_atomic_so_fn_runs_once() -> None:
    sf: SingleFlight[str, list[str]] = SingleFlight()
    work = _Work()

    # Both coroutines take their first step before the work itself has started.
    first = asyncio.create_task(sf.do("k", work))
    second = asyncio.create_task(sf.do("k", work))
    await asyncio.sleep(0)
    assert len(sf) == 1
    work.gate.set()
    await asyncio.gather(first, second)

    assert work.calls == 1


async def test_cleanup_happens_before_any_caller_resumes() -> None:
    sf: SingleFlight[str, int] = SingleFlight()
    gate = asyncio.Event()
    seen_len: list[int] = []

    async def fetcher() -> int:
        await gate.wait()
        return 1

    async def caller() -> None:
        await sf.do("k", fetcher)
        seen_len.append(len(sf))

    tasks = [asyncio.create_task(caller()) for _ in range(3)]
    await _settle()
    assert len(sf) == 1
    gate.set()
    await asyncio.gather(*tasks)

    assert seen_len == [0, 0, 0]


async def test_nothing_cached_fn_called_once_more_per_later_call() -> None:
    sf: SingleFlight[str, int] = SingleFlight()
    calls = 0

    async def fetcher() -> int:
        nonlocal calls
        calls += 1
        return calls

    assert await sf.do("k", fetcher) == 1
    assert await sf.do("k", fetcher) == 2
    assert calls == 2


# --- errors ---------------------------------------------------------------------------------


async def test_exception_same_instance_then_retry() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    error = RuntimeError("PG down")
    gate = asyncio.Event()
    calls = 0

    async def fetcher() -> str:
        nonlocal calls
        calls += 1
        await gate.wait()
        if calls == 1:
            raise error
        return "recovered"

    tasks = [asyncio.create_task(sf.do("k", fetcher)) for _ in range(3)]
    await _settle()
    gate.set()
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    assert all(outcome is error for outcome in outcomes)
    assert len(sf) == 0
    assert await sf.do("k", fetcher) == "recovered"
    assert calls == 2


async def test_fn_raises_before_first_await() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    error = ValueError("early")

    async def fetcher() -> str:
        raise error

    with pytest.raises(ValueError) as caught:
        await sf.do("k", fetcher)
    assert caught.value is error
    assert len(sf) == 0


async def test_plain_function_that_raises_instead_of_returning_awaitable() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    error = ValueError("not even a coroutine")
    calls = 0

    def fetcher() -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise error
        return asyncio.sleep(0, "retried")

    with pytest.raises(ValueError) as caught:
        await sf.do("k", fetcher)
    assert caught.value is error
    assert len(sf) == 0
    assert await sf.do("k", fetcher) == "retried"


async def test_work_that_raises_cancelled_error_reaches_every_caller() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    gate = asyncio.Event()

    async def fetcher() -> str:
        await gate.wait()
        raise asyncio.CancelledError

    tasks = [asyncio.create_task(sf.do("k", fetcher)) for _ in range(2)]
    await _settle()
    gate.set()
    outcomes = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2)

    assert all(isinstance(outcome, asyncio.CancelledError) for outcome in outcomes)
    assert len(sf) == 0


# --- caller cancellation --------------------------------------------------------------------


async def test_cancel_first_caller_second_still_gets_result() -> None:
    sf: SingleFlight[str, list[str]] = SingleFlight()
    work = _Work()

    first = asyncio.create_task(sf.do("k", work))
    await _settle()
    second = asyncio.create_task(sf.do("k", work))
    await _settle()

    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert work.cancelled == 0
    assert len(sf) == 1

    work.gate.set()
    assert await asyncio.wait_for(second, timeout=2) == ["row"]
    assert work.calls == 1
    assert len(sf) == 0


async def test_cancel_later_caller_first_still_gets_result() -> None:
    sf: SingleFlight[str, list[str]] = SingleFlight()
    work = _Work()

    first = asyncio.create_task(sf.do("k", work))
    await _settle()
    second = asyncio.create_task(sf.do("k", work))
    await _settle()

    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    assert work.cancelled == 0

    work.gate.set()
    assert await asyncio.wait_for(first, timeout=2) == ["row"]
    assert work.calls == 1
    assert len(sf) == 0


async def test_cancel_all_callers_cancels_the_work_silently() -> None:
    logged: list[dict[str, Any]] = []
    asyncio.get_running_loop().set_exception_handler(lambda _loop, ctx: logged.append(ctx))
    sf: SingleFlight[str, list[str]] = SingleFlight()
    work = _Work()

    tasks = [asyncio.create_task(sf.do("k", work)) for _ in range(3)]
    await _settle()

    tasks[0].cancel()
    tasks[1].cancel()
    await _settle()
    assert work.cancelled == 0  # one caller is still waiting
    assert len(sf) == 1

    tasks[2].cancel()
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    assert all(isinstance(outcome, asyncio.CancelledError) for outcome in outcomes)
    assert len(sf) == 0  # forgotten at once, before the work has unwound

    await _settle()
    assert work.cancelled == 1  # fn observed CancelledError
    gc.collect()
    assert logged == []


async def test_fresh_work_after_last_waiter_cancel_while_old_task_unwinds() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    unwind = asyncio.Event()
    calls = 0

    async def fetcher() -> str:
        nonlocal calls
        calls += 1
        mine = calls
        try:
            await asyncio.Event().wait() if mine == 1 else await asyncio.sleep(0)
        except asyncio.CancelledError:
            await unwind.wait()  # the old task is slow to unwind
            raise
        return f"call {mine}"

    only = asyncio.create_task(sf.do("k", fetcher))
    await _settle()
    only.cancel()
    with pytest.raises(asyncio.CancelledError):
        await only

    # The old task is still unwinding, yet a new caller gets fresh work.
    assert await asyncio.wait_for(sf.do("k", fetcher), timeout=2) == "call 2"
    assert calls == 2

    # When the old task finally finishes it must not disturb newer work for the key.
    newer = _Work("newer")
    waiter = asyncio.create_task(sf.do("k", newer))
    await _settle()
    unwind.set()
    await _settle()
    assert len(sf) == 1
    newer.gate.set()
    assert await waiter == "newer"


async def test_silence_when_work_fails_with_no_caller_left() -> None:
    logged: list[dict[str, Any]] = []
    asyncio.get_running_loop().set_exception_handler(lambda _loop, ctx: logged.append(ctx))
    sf: SingleFlight[str, str] = SingleFlight()
    failed = asyncio.Event()

    async def fetcher() -> str:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            failed.set()
            raise RuntimeError("cleanup failed") from None
        raise AssertionError("unreachable")  # pragma: no cover

    callers = [asyncio.create_task(sf.do("k", fetcher)) for _ in range(2)]
    await _settle()
    for caller in callers:
        caller.cancel()
    await asyncio.gather(*callers, return_exceptions=True)
    await asyncio.wait_for(failed.wait(), timeout=2)
    await _settle()

    del callers, caller
    gc.collect()
    await _settle()
    assert logged == []
    assert len(sf) == 0


# --- clear ----------------------------------------------------------------------------------


async def test_clear_forgets_keys_but_running_work_still_delivers() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    old, fresh = _Work("old"), _Work("fresh")

    attached = asyncio.create_task(sf.do("k", old))
    await _settle()
    sf.clear()
    assert len(sf) == 0
    assert old.cancelled == 0  # not cancelled by clear()

    # A call after clear() starts fresh work although the old task is still running.
    after = asyncio.create_task(sf.do("k", fresh))
    await _settle()
    assert (old.calls, fresh.calls) == (1, 1)

    old.gate.set()
    fresh.gate.set()
    assert await attached == "old"
    assert await after == "fresh"


async def test_clear_then_old_work_finishing_keeps_the_newer_entry() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    old, fresh = _Work("old"), _Work("fresh")

    attached = asyncio.create_task(sf.do("k", old))
    await _settle()
    sf.clear()
    after = asyncio.create_task(sf.do("k", fresh))
    await _settle()

    old.gate.set()
    assert await attached == "old"
    assert len(sf) == 1  # the newer entry survived the old work finishing

    joiner = asyncio.create_task(sf.do("k", fresh))
    await _settle()
    assert fresh.calls == 1  # the joiner shares the newer work
    fresh.gate.set()
    assert await asyncio.gather(after, joiner) == ["fresh", "fresh"]
    assert len(sf) == 0


async def test_clear_keeps_waiter_count_and_last_waiter_cancel_still_cancels() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    old, fresh = _Work("old"), _Work("fresh")

    first = asyncio.create_task(sf.do("k", old))
    second = asyncio.create_task(sf.do("k", old))
    await _settle()
    sf.clear()
    after = asyncio.create_task(sf.do("k", fresh))
    await _settle()

    first.cancel()
    await _settle()
    assert old.cancelled == 0  # `second` still waits on the cleared work

    second.cancel()
    await asyncio.gather(first, second, return_exceptions=True)
    await _settle()
    assert old.cancelled == 1  # last waiter left: the cleared work is cancelled
    assert len(sf) == 1  # and the newer entry under the same key is untouched

    fresh.gate.set()
    assert await after == "fresh"


# --- context and isolation ------------------------------------------------------------------


async def test_fn_runs_in_first_callers_context() -> None:
    sf: SingleFlight[str, str] = SingleFlight()
    who: contextvars.ContextVar[str] = contextvars.ContextVar("who", default="nobody")
    gate = asyncio.Event()

    async def fetcher() -> str:
        await gate.wait()
        return who.get()

    async def caller(name: str) -> str:
        who.set(name)
        return await sf.do("k", fetcher)

    first = asyncio.create_task(caller("first"))
    await _settle()
    second = asyncio.create_task(caller("second"))
    await _settle()
    gate.set()

    assert await asyncio.gather(first, second) == ["first", "first"]


async def test_two_instances_share_nothing() -> None:
    one: SingleFlight[str, str] = SingleFlight()
    two: SingleFlight[str, str] = SingleFlight()
    work_one, work_two = _Work("one"), _Work("two")

    first = asyncio.create_task(one.do("k", work_one))
    second = asyncio.create_task(two.do("k", work_two))
    await _settle()
    assert (work_one.calls, work_two.calls) == (1, 1)
    assert (len(one), len(two)) == (1, 1)

    one.clear()
    assert (len(one), len(two)) == (0, 1)

    work_one.gate.set()
    work_two.gate.set()
    assert await asyncio.gather(first, second) == ["one", "two"]

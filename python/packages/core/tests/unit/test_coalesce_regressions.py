"""Regression tests for @batch_load: cancellation, scope leak, key binding, clear race."""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import decimal
import gc
import uuid
import weakref
from typing import Any

import pytest

from server_decorator.decorators.coalesce import batch_load


class _L2:
    def __init__(self) -> None:
        self.data: dict[str, Any] = {}
        self.del_count = 0

    async def mget(self, keys: list[str]) -> dict[str, Any]:
        return {k: self.data[k] for k in keys if k in self.data}

    async def set_many(self, items: dict[str, Any], ttl: float = 0) -> None:
        self.data.update(items)

    async def delete(self, keys: list[str]) -> None:
        self.del_count += 1
        for k in keys:
            self.data.pop(k, None)


# --- cancelling one caller must not cancel the shared in-flight load ---------------------------


@pytest.mark.asyncio
async def test_cancelled_caller_does_not_cancel_other_waiters() -> None:
    release = asyncio.Event()
    calls: list[list[int]] = []

    async def fetch(keys: list[int]) -> dict[int, str]:
        calls.append(keys)
        await release.wait()
        return {k: f"v{k}" for k in keys}

    @batch_load(fetch)
    async def get(key: int) -> str | None:
        return None

    a = asyncio.create_task(get(1))
    b = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    a.cancel()
    await asyncio.sleep(0)
    release.set()

    with pytest.raises(asyncio.CancelledError):
        await a
    assert await b == "v1"
    assert calls == [[1]]
    # The settled value is still cached for the next caller.
    assert await get(1) == "v1"
    assert calls == [[1]]


@pytest.mark.asyncio
async def test_timeout_of_one_caller_does_not_fail_the_other() -> None:
    release = asyncio.Event()

    async def fetch(keys: list[int]) -> dict[int, str]:
        await release.wait()
        return {k: f"v{k}" for k in keys}

    @batch_load(fetch)
    async def get(key: int) -> str | None:
        return None

    slow = asyncio.create_task(get(1))
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(get(1), timeout=0.01)
    release.set()
    assert await slow == "v1"


# --- key binding must not guess `self` from the argument type ---------------------------------


@dataclasses.dataclass(frozen=True)
class _CompositeKey:
    tenant: str
    ident: int


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "keys",
    [
        [uuid.UUID(int=1), uuid.UUID(int=2)],
        [b"a", b"b"],
        [decimal.Decimal("1.5"), decimal.Decimal("2.5")],
        [_CompositeKey("t", 1), _CompositeKey("t", 2)],
    ],
    ids=["uuid", "bytes", "decimal", "frozen-dataclass"],
)
async def test_plain_function_with_non_primitive_key(keys: list[Any]) -> None:
    batches: list[list[Any]] = []

    async def fetch(ks: list[Any]) -> dict[Any, str]:
        batches.append(list(ks))
        return {k: f"v-{k}" for k in ks}

    @batch_load(fetch)
    async def get(key: Any) -> str | None:
        return None

    results = await asyncio.gather(*(get(k) for k in keys))

    assert results == [f"v-{k}" for k in keys]
    assert batches == [keys]


@pytest.mark.asyncio
async def test_plain_function_key_passed_by_parameter_name() -> None:
    batches: list[list[Any]] = []

    async def fetch(ks: list[Any]) -> dict[Any, str]:
        batches.append(list(ks))
        return {k: f"v-{k}" for k in ks}

    @batch_load(fetch)
    async def get(user_id: Any) -> str | None:
        return None

    u = uuid.UUID(int=7)
    assert await get(user_id=u) == f"v-{u}"
    assert batches == [[u]]


@pytest.mark.asyncio
async def test_method_with_non_primitive_key_and_keyword_key() -> None:
    class Svc:
        def __init__(self) -> None:
            self.batches: list[list[Any]] = []

        async def fetch(self, ks: list[Any]) -> dict[Any, str]:
            self.batches.append(list(ks))
            return {k: f"v-{k}" for k in ks}

        @batch_load(batch_method="fetch")
        async def get(self, user_id: Any) -> str | None:
            return None

    svc = Svc()
    u1, u2 = uuid.UUID(int=1), uuid.UUID(int=2)
    results = await asyncio.gather(svc.get(u1), svc.get(user_id=u2))
    assert list(results) == [f"v-{u1}", f"v-{u2}"]
    assert svc.batches == [[u1, u2]]


# --- per-scope queues must not be retained forever ---------------------------------------------


class _RequestScope:
    pass


@pytest.mark.asyncio
async def test_finished_context_scopes_are_not_retained() -> None:
    ctx: contextvars.ContextVar[Any] = contextvars.ContextVar("req_scope")
    l2 = _L2()

    class Svc:
        async def fetch(self, ks: list[str]) -> dict[str, str]:
            return {k: f"v-{k}" for k in ks}

        @batch_load(batch_method="fetch", context_var=ctx, l2_cache=l2)
        async def get(self, key: str) -> str | None:
            return None

    svc = Svc()
    refs: list[weakref.ref[_RequestScope]] = []

    async def one_request(i: int) -> None:
        scope = _RequestScope()
        refs.append(weakref.ref(scope))
        ctx.set(scope)
        assert await svc.get(f"k{i}") == f"v-k{i}"

    for i in range(50):
        await asyncio.create_task(one_request(i))
    await asyncio.sleep(0.01)
    gc.collect()

    assert sum(1 for r in refs if r() is not None) == 0

    # Invalidation cost must not grow with the number of requests served.
    l2.del_count = 0
    await svc.get.clear("k1")  # type: ignore[attr-defined]
    assert l2.del_count == 1


@pytest.mark.asyncio
async def test_transient_service_instances_are_not_retained() -> None:
    class Svc:
        async def fetch(self, ks: list[str]) -> dict[str, str]:
            return {k: f"v-{k}" for k in ks}

        @batch_load(batch_method="fetch")
        async def get(self, key: str) -> str | None:
            return None

    refs: list[weakref.ref[Svc]] = []
    for i in range(50):
        svc = Svc()
        refs.append(weakref.ref(svc))
        assert await svc.get(f"k{i}") == f"v-k{i}"
    del svc
    await asyncio.sleep(0.01)
    gc.collect()

    assert sum(1 for r in refs if r() is not None) == 0


@pytest.mark.asyncio
async def test_non_weakrefable_scope_values_are_bounded() -> None:
    ctx: contextvars.ContextVar[str] = contextvars.ContextVar("req_id")
    seen: list[weakref.ref[Any]] = []

    class Payload:
        def __init__(self, k: str) -> None:
            self.id = k

    class Svc:
        async def fetch(self, ks: list[str]) -> list[Payload]:
            out = [Payload(k) for k in ks]
            seen.extend(weakref.ref(p) for p in out)
            return out

        @batch_load(batch_method="fetch", context_var=ctx)
        async def get(self, key: str) -> Payload | None:
            return None

    svc = Svc()

    async def one_request(i: int) -> None:
        ctx.set(f"request-{i}")
        assert (await svc.get(f"k{i}")).id == f"k{i}"  # type: ignore[union-attr]

    total = 1500
    for i in range(total):
        await asyncio.create_task(one_request(i))
    await asyncio.sleep(0.01)
    gc.collect()

    alive = sum(1 for r in seen if r() is not None)
    assert alive <= 1024
    assert alive < total


@pytest.mark.asyncio
async def test_clear_still_invalidates_every_live_scope() -> None:
    ctx: contextvars.ContextVar[str] = contextvars.ContextVar("tenant")
    calls = 0

    class Svc:
        async def fetch(self, ks: list[str]) -> dict[str, str]:
            nonlocal calls
            calls += 1
            return {k: f"v{calls}" for k in ks}

        @batch_load(batch_method="fetch", context_var=ctx)
        async def get(self, key: str) -> str | None:
            return None

    svc = Svc()

    async def read(tenant: str) -> str | None:
        ctx.set(tenant)
        return await svc.get("x")

    assert await asyncio.create_task(read("A")) == "v1"
    assert await asyncio.create_task(read("B")) == "v2"
    await svc.get.clear("x")  # type: ignore[attr-defined]
    assert await asyncio.create_task(read("A")) == "v3"
    assert await asyncio.create_task(read("B")) == "v4"


# --- clear() racing an in-flight load ------------------------------------------------------------


class _RacingStore:
    def __init__(self, initial: dict[int, str]) -> None:
        self.db = dict(initial)
        self.gates: list[asyncio.Event] = []
        self.calls = 0

    async def fetch(self, ks: list[int]) -> dict[int, str]:
        self.calls += 1
        snapshot = {k: self.db[k] for k in ks if k in self.db}  # read, then block
        gate = asyncio.Event()
        self.gates.append(gate)
        await gate.wait()
        return snapshot


@pytest.mark.asyncio
async def test_read_after_clear_does_not_join_the_stale_flight() -> None:
    store = _RacingStore({1: "old"})
    l2 = _L2()

    @batch_load(store.fetch, l2_cache=l2, l2_ttl_seconds=60)
    async def get(key: int) -> str | None:
        return None

    first = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    assert store.calls == 1

    store.db[1] = "new"
    await get.clear(1)  # type: ignore[attr-defined]

    after_clear = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    assert store.calls == 2

    store.gates[1].set()
    assert await after_clear == "new"
    store.gates[0].set()
    assert await first == "old"  # the read that began before the write keeps its value
    await asyncio.sleep(0.01)

    # The late-settling stale flight must not overwrite L1 or L2.
    assert await get(1) == "new"
    assert store.calls == 2
    assert l2.data.get("1") == '"new"'


@pytest.mark.asyncio
async def test_stale_flight_is_not_written_back_after_clear() -> None:
    store = _RacingStore({1: "old"})
    l2 = _L2()

    @batch_load(store.fetch, l2_cache=l2, l2_ttl_seconds=60)
    async def get(key: int) -> str | None:
        return None

    first = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    store.db[1] = "new"
    await get.clear(1)  # type: ignore[attr-defined]
    store.gates[0].set()
    assert await first == "old"
    await asyncio.sleep(0.01)

    assert "1" not in l2.data
    nxt = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    assert store.calls == 2  # L1 did not serve "old"
    store.gates[1].set()
    assert await nxt == "new"


@pytest.mark.asyncio
async def test_cleared_key_is_not_negative_cached_by_the_stale_flight() -> None:
    store = _RacingStore({})

    @batch_load(store.fetch)
    async def get(key: int) -> str | None:
        return None

    first = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    store.db[1] = "created"
    await get.clear(1)  # type: ignore[attr-defined]
    store.gates[0].set()
    assert await first is None

    nxt = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    assert store.calls == 2
    store.gates[1].set()
    assert await nxt == "created"


@pytest.mark.asyncio
async def test_dedup_survives_the_invalidated_flight_settling() -> None:
    store = _RacingStore({1: "old"})

    @batch_load(store.fetch)
    async def get(key: int) -> str | None:
        return None

    first = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    store.db[1] = "new"
    await get.clear(1)  # type: ignore[attr-defined]

    second = asyncio.create_task(get(1))
    await asyncio.sleep(0.01)
    store.gates[0].set()
    await first
    await asyncio.sleep(0.01)
    third = asyncio.create_task(get(1))  # must join the new flight, not start a third
    await asyncio.sleep(0.01)
    assert store.calls == 2
    store.gates[1].set()
    assert await second == "new"
    assert await third == "new"

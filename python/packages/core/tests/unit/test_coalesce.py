"""Unit tests for @batch_load async call coalescing decorator."""

from __future__ import annotations

import asyncio
import contextvars
from typing import Any

import pytest

from server_decorator.decorators.coalesce import batch_load


class MockUserService:
    def __init__(self) -> None:
        self.batch_call_count = 0
        self.requested_keys: list[list[str]] = []

    async def find_users_by_ids(self, ids: list[str]) -> dict[str, dict[str, str]]:
        self.batch_call_count += 1
        self.requested_keys.append(list(ids))
        return {uid: {"id": uid, "name": f"User {uid}"} for uid in ids}

    @batch_load(batch_method="find_users_by_ids", window_seconds=0.005)
    async def find_user_by_id(self, user_id: str) -> dict[str, str] | None:
        return None


class FailingService:
    async def find_bad(self, ids: list[str]) -> Any:
        raise RuntimeError("database connection failed")

    @batch_load(batch_method="find_bad", window_seconds=0.005)
    async def get_bad(self, item_id: str) -> Any:
        return None


class ModelItem:
    def __init__(self, key: str, value: str) -> None:
        self.id = key
        self.value = value


class ModelService:
    def __init__(self) -> None:
        self.batch_call_count = 0

    async def list_models(self, ids: list[str]) -> list[ModelItem]:
        self.batch_call_count += 1
        return [ModelItem(k, f"val-{k}") for k in ids]

    @batch_load(batch_method="list_models", window_seconds=0.005)
    async def get_model(self, item_id: str) -> ModelItem | None:
        return None


@pytest.mark.asyncio
async def test_batch_load_coalesces_concurrent_calls() -> None:
    svc = MockUserService()

    u1, u2, u3, u4 = await asyncio.gather(
        svc.find_user_by_id("1"),
        svc.find_user_by_id("2"),
        svc.find_user_by_id("3"),
        svc.find_user_by_id("4"),
    )

    assert svc.batch_call_count == 1
    assert svc.requested_keys == [["1", "2", "3", "4"]]
    assert u1 == {"id": "1", "name": "User 1"}
    assert u2 == {"id": "2", "name": "User 2"}
    assert u3 == {"id": "3", "name": "User 3"}
    assert u4 == {"id": "4", "name": "User 4"}


@pytest.mark.asyncio
async def test_batch_load_deduplicates_in_flight() -> None:
    svc = MockUserService()

    # 4 concurrent requests for the SAME key
    res = await asyncio.gather(
        svc.find_user_by_id("dup-1"),
        svc.find_user_by_id("dup-1"),
        svc.find_user_by_id("dup-1"),
        svc.find_user_by_id("dup-2"),
    )

    assert svc.batch_call_count == 1
    assert svc.requested_keys == [["dup-1", "dup-2"]]
    assert res[0] == {"id": "dup-1", "name": "User dup-1"}
    assert res[1] == {"id": "dup-1", "name": "User dup-1"}
    assert res[3] == {"id": "dup-2", "name": "User dup-2"}


@pytest.mark.asyncio
async def test_batch_load_propagates_rejection() -> None:
    svc = FailingService()

    with pytest.raises(RuntimeError, match="database connection failed"):
        await asyncio.gather(svc.get_bad("1"), svc.get_bad("2"))


@pytest.mark.asyncio
async def test_batch_load_model_list_return() -> None:
    svc = ModelService()

    m1, m2 = await asyncio.gather(svc.get_model("a"), svc.get_model("b"))

    assert svc.batch_call_count == 1
    assert m1 is not None and m1.id == "a" and m1.value == "val-a"
    assert m2 is not None and m2.id == "b" and m2.value == "val-b"


@pytest.mark.asyncio
async def test_batch_load_max_batch_size_immediate_dispatch() -> None:
    svc = MockUserService()

    # Override method with max_batch_size=2
    @batch_load(batch_method="find_users_by_ids", max_batch_size=2, window_seconds=1.0)
    async def get_small_batch(self: MockUserService, item_id: str) -> Any:
        return None

    MockUserService.get_small_batch = get_small_batch  # type: ignore[attr-defined]

    # 4 items launched together: should immediately dispatch in chunks of 2
    r1, _r2, _r3, r4 = await asyncio.gather(
        svc.get_small_batch("x1"),
        svc.get_small_batch("x2"),
        svc.get_small_batch("x3"),
        svc.get_small_batch("x4"),
    )

    assert svc.batch_call_count >= 2
    assert r1["id"] == "x1"
    assert r4["id"] == "x4"


@pytest.mark.asyncio
async def test_batch_load_context_isolation() -> None:
    ctx: contextvars.ContextVar[str] = contextvars.ContextVar("tenant_ctx")

    class TenantService:
        def __init__(self) -> None:
            self.call_count = 0

        async def fetch_batch(self, ids: list[str]) -> dict[str, str]:
            self.call_count += 1
            return {i: f"val-{i}" for i in ids}

        @batch_load(batch_method="fetch_batch", context_var=ctx, window_seconds=0.005)
        async def fetch_one(self, item_id: str) -> str | None:
            return None

    svc = TenantService()

    async def run_in_tenant(tenant: str, id_val: str) -> str | None:
        ctx.set(tenant)
        return await svc.fetch_one(id_val)

    t1_res, t2_res = await asyncio.gather(
        run_in_tenant("tenant-A", "1"),
        run_in_tenant("tenant-B", "2"),
    )

    assert svc.call_count == 2
    assert t1_res == "val-1"
    assert t2_res == "val-2"

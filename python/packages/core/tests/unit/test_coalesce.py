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


class MockL2Cache:
    def __init__(self) -> None:
        self.data: dict[str, Any] = {}
        self.mget_count = 0
        self.set_count = 0
        self.del_count = 0

    async def mget(self, keys: list[str]) -> dict[str, Any]:
        self.mget_count += 1
        return {k: self.data[k] for k in keys if k in self.data}

    async def set_many(self, items: dict[str, Any], ttl: float = 0) -> None:
        self.set_count += 1
        self.data.update(items)

    async def delete(self, keys: list[str]) -> None:
        self.del_count += 1
        for k in keys:
            self.data.pop(k, None)


@pytest.mark.asyncio
async def test_batch_load_multi_tier_caching_and_eviction() -> None:
    l2 = MockL2Cache()
    db_calls = 0

    class MultiTierUserService:
        async def find_users(self, ids: list[str]) -> dict[str, dict[str, str]]:
            nonlocal db_calls
            db_calls += 1
            return {i: {"id": i, "name": f"User {i}"} for i in ids if i != "missing"}

        @batch_load(
            batch_method="find_users",
            l1_max_size=100,
            l1_ttl_seconds=5.0,
            l2_cache=l2,
            l2_ttl_seconds=300.0,
            negative_ttl_seconds=5.0,
            window_seconds=0.005,
        )
        async def find_user(self, user_id: str) -> dict[str, str] | None:
            return None

    svc = MultiTierUserService()

    # 1. Initial query -> misses L1 & L2 -> fetches from L3 DB -> backfills L2 & L1
    u1 = await svc.find_user("1")
    assert u1 == {"id": "1", "name": "User 1"}
    assert db_calls == 1
    assert l2.set_count == 1
    assert "1" in l2.data

    # 2. Immediate second query -> hits L1 -> 0 new DB calls, 0 new MGET calls
    u1_again = await svc.find_user("1")
    assert u1_again == {"id": "1", "name": "User 1"}
    assert db_calls == 1
    assert l2.mget_count == 1  # Did not increment

    # 3. Pre-populate L2 for user '2' -> hits L2, backfills L1, skips DB
    import json

    l2.data["2"] = json.dumps({"id": "2", "name": "From Redis"})
    u2 = await svc.find_user("2")
    assert u2 == {"id": "2", "name": "From Redis"}
    assert db_calls == 1  # DB was skipped!
    assert l2.mget_count == 2

    # 4. Negative caching: query missing key
    missing1 = await svc.find_user("missing")
    assert missing1 is None
    assert db_calls == 2

    # Second query for missing key -> hits negative cache -> 0 new DB calls
    missing2 = await svc.find_user("missing")
    assert missing2 is None
    assert db_calls == 2

    # 5. Eviction test: clear user '1'
    await svc.find_user.clear("1")  # type: ignore[attr-defined]
    assert l2.del_count == 1
    assert "1" not in l2.data

    # Querying user '1' after eviction hits DB again
    u1_refetched = await svc.find_user("1")
    assert u1_refetched == {"id": "1", "name": "User 1"}
    assert db_calls == 3


@pytest.mark.asyncio
async def test_batch_load_prime_bypasses_db() -> None:
    db_calls = 0

    class PrimeService:
        async def batch_users(self, ids: list[str]) -> dict[str, dict[str, str]]:
            nonlocal db_calls
            db_calls += 1
            return {uid: {"id": uid, "name": f"DB User {uid}"} for uid in ids}

        @batch_load(batch_method="batch_users", window_seconds=0.005)
        async def find_user(self, user_id: str) -> dict[str, str] | None:
            return None

    svc = PrimeService()

    # Prime cache before query
    svc.find_user.prime("user-1", {"id": "user-1", "name": "Primed User"}, instance=svc)  # type: ignore[attr-defined]

    user = await svc.find_user("user-1")
    assert user == {"id": "user-1", "name": "Primed User"}
    assert db_calls == 0


@pytest.mark.asyncio
async def test_batch_load_cascading_prefetch() -> None:
    user_db_calls = 0
    item_db_calls = 0

    class UserService:
        async def batch_users(self, ids: list[str]) -> dict[str, dict[str, str]]:
            nonlocal user_db_calls
            user_db_calls += 1
            return {uid: {"id": uid, "name": f"User {uid}"} for uid in ids}

        @batch_load(batch_method="batch_users", window_seconds=0.005)
        async def find_user(self, user_id: str) -> dict[str, str] | None:
            return None

    class ItemService:
        async def batch_items(self, ids: list[str]) -> dict[str, dict[str, str]]:
            nonlocal item_db_calls
            item_db_calls += 1
            return {iid: {"id": iid, "title": f"Item {iid}"} for iid in ids}

        @batch_load(batch_method="batch_items", window_seconds=0.005)
        async def find_item(self, item_id: str) -> dict[str, str] | None:
            return None

    user_svc = UserService()
    item_svc = ItemService()

    class OrderService:
        async def batch_orders(self, ids: list[str]) -> dict[str, dict[str, Any]]:
            return {
                oid: {
                    "id": oid,
                    "user_id": f"u-{oid}",
                    "item_ids": [f"it-1-{oid}", f"it-2-{oid}"],
                }
                for oid in ids
            }

        @batch_load(
            batch_method="batch_orders",
            window_seconds=0.005,
            prefetch=[
                {
                    "extract": lambda o: o["user_id"],
                    "loader": lambda: user_svc.find_user,
                },
                {
                    "extract": lambda o: o["item_ids"],
                    "loader": lambda: item_svc.find_item,
                },
            ],
        )
        async def find_order(self, order_id: str) -> dict[str, Any] | None:
            return None

    order_svc = OrderService()

    # 1. Fetch order -> triggers background prefetch for user 'u-1' and items ['it-1-1', 'it-2-1']
    order = await order_svc.find_order("1")
    assert order == {
        "id": "1",
        "user_id": "u-1",
        "item_ids": ["it-1-1", "it-2-1"],
    }

    # Wait for micro-tick prefetch to settle
    await asyncio.sleep(0.05)

    assert user_db_calls == 1
    assert item_db_calls == 1

    # 2. Downstream queries hit L1 memory cache with 0 additional DB calls
    user = await user_svc.find_user("u-1")
    assert user == {"id": "u-1", "name": "User u-1"}
    assert user_db_calls == 1  # No new DB call!

    item1 = await item_svc.find_item("it-1-1")
    item2 = await item_svc.find_item("it-2-1")
    assert item1 == {"id": "it-1-1", "title": "Item it-1-1"}
    assert item2 == {"id": "it-2-1", "title": "Item it-2-1"}
    assert item_db_calls == 1  # No new DB call!


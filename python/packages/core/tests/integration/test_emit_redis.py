"""Integration test: @emit_on_success → real Redis stream → consumer reads back."""

from __future__ import annotations

import asyncio
import json

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def redis_container():
    from testcontainers.redis import RedisContainer

    with RedisContainer("redis:7-alpine") as r:
        yield r


async def test_emit_to_redis_stream(redis_container) -> None:
    import redis.asyncio as redis_asyncio

    from server_decorator import emit_on_success, global_queue_registry
    from server_decorator.queue.adapters.redis_adapter import RedisStreamAdapter

    host = redis_container.get_container_host_ip()
    port = int(redis_container.get_exposed_port(6379))
    client = redis_asyncio.from_url(f"redis://{host}:{port}")

    global_queue_registry.clear()
    global_queue_registry.register("redis", RedisStreamAdapter(client, stream="orders"))
    global_queue_registry.set_default("redis")

    class OrderService:
        @emit_on_success(queue="redis", topic="orders", use_queue=True, use_events=False)
        async def create_order(self, customer_id: str, total: float) -> dict:
            return {"customerId": customer_id, "total": total, "status": "pending"}

    svc = OrderService()
    order = await svc.create_order("cust-1", 42.5)
    assert order["status"] == "pending"

    await asyncio.sleep(0.1)
    entries = await client.xrange("orders", count=10)
    assert len(entries) == 1
    body = json.loads(entries[0][1][b"data"])
    assert body["eventName"] == "OrderService.create_order"
    assert body["payload"]["customerId"] == "cust-1"

    await client.close()


async def test_emit_class_form_to_redis_stream(redis_container) -> None:
    import redis.asyncio as redis_asyncio

    from server_decorator import emit_on_success_class, global_queue_registry
    from server_decorator.queue.adapters.redis_adapter import RedisStreamAdapter

    host = redis_container.get_container_host_ip()
    port = int(redis_container.get_exposed_port(6379))
    client = redis_asyncio.from_url(f"redis://{host}:{port}")

    global_queue_registry.clear()
    global_queue_registry.register("redis", RedisStreamAdapter(client, stream="inventory"))
    global_queue_registry.set_default("redis")

    @emit_on_success_class(queue="redis", topic="inventory", use_queue=True, use_events=False)
    class InventoryService:
        async def restock(self, sku: str, qty: int) -> dict:
            return {"sku": sku, "qty": qty, "kind": "restock"}

        async def reserve(self, sku: str, qty: int) -> dict:
            return {"sku": sku, "qty": qty, "kind": "reserve"}

        def _internal_check(self, sku: str) -> bool:
            return True  # MUST NOT publish

    svc = InventoryService()
    await svc.restock("WIDGET-1", 50)
    await svc.reserve("WIDGET-1", 3)
    svc._internal_check("WIDGET-1")

    await asyncio.sleep(0.1)
    entries = await client.xrange("inventory", count=10)
    event_names = sorted(json.loads(e[1][b"data"])["eventName"] for e in entries)
    assert event_names == ["InventoryService.reserve", "InventoryService.restock"]

    await client.close()

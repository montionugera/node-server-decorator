"""Integration test: @emit_on_success → real RabbitMQ → consumer reads back."""

from __future__ import annotations

import asyncio
import json

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def rabbitmq_container():
    from testcontainers.rabbitmq import RabbitMqContainer

    with RabbitMqContainer("rabbitmq:3-management-alpine") as r:
        yield r


async def test_emit_to_rabbitmq_queue(rabbitmq_container) -> None:
    import aio_pika

    from server_decorator import emit_on_success, global_queue_registry
    from server_decorator.queue.adapters.rabbitmq_adapter import RabbitMQAdapter

    url = rabbitmq_container.get_connection_url()
    connection = await aio_pika.connect_robust(url)
    channel = await connection.channel()
    await channel.declare_queue("orders", durable=False)

    global_queue_registry.clear()
    global_queue_registry.register("rabbit", RabbitMQAdapter(channel, "orders"))
    global_queue_registry.set_default("rabbit")

    class OrderService:
        @emit_on_success(queue="rabbit", use_queue=True, use_events=False)
        async def create_order(self, customer_id: str) -> dict:
            return {"customerId": customer_id}

    await OrderService().create_order("cust-1")

    queue = await channel.declare_queue("orders", durable=False)
    received = []

    async def consume() -> None:
        async with queue.iterator(timeout=2) as it:
            async for message in it:
                async with message.process():
                    received.append(json.loads(message.body))
                    return

    try:
        await asyncio.wait_for(consume(), timeout=3)
    except asyncio.TimeoutError:
        pass

    assert len(received) == 1
    assert received[0]["eventName"] == "OrderService.create_order"
    assert received[0]["payload"]["customerId"] == "cust-1"

    await connection.close()

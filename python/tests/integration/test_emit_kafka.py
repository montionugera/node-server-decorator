"""Integration test: @emit_on_success → real Kafka → consumer reads back."""

from __future__ import annotations

import asyncio
import json

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def kafka_container():
    from testcontainers.kafka import KafkaContainer

    with KafkaContainer() as k:
        yield k


async def test_emit_to_kafka_topic(kafka_container) -> None:
    from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

    from server_decorator import emit_on_success, global_queue_registry
    from server_decorator.queue.adapters.kafka_adapter import KafkaAdapter

    bootstrap = kafka_container.get_bootstrap_server()

    producer = AIOKafkaProducer(bootstrap_servers=bootstrap)
    await producer.start()

    global_queue_registry.clear()
    global_queue_registry.register(
        "kafka", KafkaAdapter(producer, default_topic="orders")
    )
    global_queue_registry.set_default("kafka")

    class OrderService:
        @emit_on_success(queue="kafka", topic="orders", use_queue=True, use_events=False)
        async def create_order(self, customer_id: str) -> dict:
            return {"customerId": customer_id}

    await OrderService().create_order("cust-1")

    consumer = AIOKafkaConsumer(
        "orders", bootstrap_servers=bootstrap, auto_offset_reset="earliest", group_id="t"
    )
    await consumer.start()
    try:
        msg = await asyncio.wait_for(consumer.getone(), timeout=10)
        body = json.loads(msg.value)
        assert body["eventName"] == "OrderService.create_order"
        assert body["payload"]["customerId"] == "cust-1"
    finally:
        await consumer.stop()
        await producer.stop()

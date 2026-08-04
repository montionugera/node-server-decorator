import asyncio
import json

import pytest

aio_pika = pytest.importorskip("aio_pika")
from testcontainers.rabbitmq import RabbitMqContainer  # noqa: E402

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.rabbitmq_consumer import RabbitMQConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_acks() -> None:
    with RabbitMqContainer() as rabbit:
        params = rabbit.get_connection_params()
        url = f"amqp://guest:guest@{params.host}:{params.port}/"
        queue_name = "A.x.queue"

        conn = await aio_pika.connect_robust(url)
        channel = await conn.channel()
        await channel.declare_queue(queue_name, durable=True)
        for n in (1, 2):
            msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
            await channel.default_exchange.publish(
                aio_pika.Message(body=json.dumps(msg).encode()), routing_key=queue_name
            )

        got: list = []
        reg = ConsumerRegistry()
        reg.register("c", RabbitMQConsumer(channel, queue=queue_name))

        @on_event("A.x", consumer="c", registry=reg)
        async def handle(payload, meta):
            got.append(payload)

        await reg.start()
        deadline = asyncio.get_event_loop().time() + 30
        while len(got) < 2 and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
            await asyncio.sleep(0.2)
        await reg.stop()
        await conn.close()

        assert got == [{"n": 1}, {"n": 2}]

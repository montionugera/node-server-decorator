import asyncio
import json

import pytest

aiokafka = pytest.importorskip("aiokafka")
from testcontainers.kafka import KafkaContainer  # noqa: E402

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.kafka_consumer import KafkaConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_commits() -> None:
    with KafkaContainer() as kafka:
        bootstrap = kafka.get_bootstrap_server()

        producer = aiokafka.AIOKafkaProducer(bootstrap_servers=bootstrap)
        await producer.start()
        for n in (1, 2):
            msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
            await producer.send_and_wait("A.x", json.dumps(msg).encode())
        await producer.stop()

        got: list = []
        reg = ConsumerRegistry()
        reg.register("c", KafkaConsumer(bootstrap, topics=["A.x"], group_id="g1"))

        @on_event("A.x", consumer="c", registry=reg)
        async def handle(payload, meta):
            got.append(payload)

        await reg.start()
        deadline = asyncio.get_event_loop().time() + 30
        while len(got) < 2 and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
            await asyncio.sleep(0.2)
        await reg.stop()

        assert got == [{"n": 1}, {"n": 2}]

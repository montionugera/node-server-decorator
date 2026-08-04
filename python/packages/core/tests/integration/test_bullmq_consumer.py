import asyncio

import pytest

bullmq = pytest.importorskip("bullmq")

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.bullmq_consumer import BullMQConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_bullmq_jobs(redis_url: str) -> None:
    from bullmq import Queue

    queue_name = "A.x.bullmq.py"
    queue = Queue(queue_name, {"connection": redis_url})
    for n in (1, 2):
        msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
        await queue.add("A.x", msg)

    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", BullMQConsumer(queue_name=queue_name, connection=redis_url))

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 20
    while len(got) < 2 and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
        await asyncio.sleep(0.2)
    await reg.stop()
    await queue.close()

    assert sorted(got, key=lambda p: p["n"]) == [{"n": 1}, {"n": 2}]

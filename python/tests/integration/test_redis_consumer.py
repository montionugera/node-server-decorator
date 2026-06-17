import asyncio
import json

import pytest

redis_asyncio = pytest.importorskip("redis.asyncio")

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.redis_consumer import RedisStreamConsumer  # noqa: E402

pytestmark = pytest.mark.integration


async def test_consumes_and_acks(redis_url: str) -> None:
    client = redis_asyncio.from_url(redis_url)
    stream = "test-consume-stream"
    group = "test-group"
    await client.delete(stream)

    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=stream, group=group, consumer_name="w1"))

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    # Produce two messages directly.
    for n in (1, 2):
        msg = {"eventName": "A.x", "payload": {"n": n}, "timestamp": 1, "metadata": {}}
        await client.xadd(stream, {"data": json.dumps(msg)})

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 5
    while len(got) < 2 and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
        await asyncio.sleep(0.05)
    await reg.stop()

    assert got == [{"n": 1}, {"n": 2}]
    # All acked: pending entries list is empty.
    pending = await client.xpending(stream, group)
    assert pending["pending"] == 0
    await client.aclose()

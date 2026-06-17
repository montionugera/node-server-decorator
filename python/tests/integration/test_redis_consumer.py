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


async def test_failing_handler_leaves_entry_pending_and_consumer_survives(
    redis_url: str,
) -> None:
    client = redis_asyncio.from_url(redis_url)
    stream = "test-poison-stream"
    group = "test-poison-group"
    await client.delete(stream)

    ok: list = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=stream, group=group, consumer_name="w1"))

    @on_event("A.fail", consumer="c", registry=reg)
    async def handle_fail(payload, meta):
        raise RuntimeError("poison")

    @on_event("A.ok", consumer="c", registry=reg)
    async def handle_ok(payload, meta):
        ok.append(payload)

    # Produce a poison message first, then a good one.
    fail_msg = {"eventName": "A.fail", "payload": {"n": 1}, "timestamp": 1, "metadata": {}}
    ok_msg = {"eventName": "A.ok", "payload": {"n": 2}, "timestamp": 1, "metadata": {}}
    await client.xadd(stream, {"data": json.dumps(fail_msg)})
    await client.xadd(stream, {"data": json.dumps(ok_msg)})

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 5
    while not ok and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
        await asyncio.sleep(0.05)
    await reg.stop()

    # The good message was processed → the poison message did not kill the consumer.
    assert ok == [{"n": 2}]
    # The poison message stays pending (not acked) for later reclaim.
    pending = await client.xpending(stream, group)
    assert pending["pending"] >= 1
    await client.aclose()


async def test_acks_and_skips_unparseable_entry(redis_url: str) -> None:
    client = redis_asyncio.from_url(redis_url)
    stream = "test-py-malformed-stream"
    group = "test-py-malformed-group"
    await client.delete(stream)

    got: list = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=stream, group=group, consumer_name="w1"))

    @on_event("A.ok", consumer="c", registry=reg)
    async def handle_ok(payload, meta):
        got.append(payload)

    # Malformed entry (no `data` field) first, then a good one.
    await client.xadd(stream, {"notdata": "garbage"})
    good_msg = {"eventName": "A.ok", "payload": {"n": 9}, "timestamp": 1, "metadata": {}}
    await client.xadd(stream, {"data": json.dumps(good_msg)})

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 5
    while not got and asyncio.get_event_loop().time() < deadline:  # noqa: ASYNC110
        await asyncio.sleep(0.05)
    await reg.stop()

    # The good message was processed despite the malformed one preceding it.
    assert got == [{"n": 9}]
    # The malformed entry was acked (not left pending) → PEL is empty.
    pending = await client.xpending(stream, group)
    assert pending["pending"] == 0
    await client.aclose()

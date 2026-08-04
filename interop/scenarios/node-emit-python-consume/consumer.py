"""Python consumer using @on_event + RedisStreamConsumer to receive the Node-produced
messages, asserting payload equality with the shared fixture."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import redis.asyncio as redis_asyncio

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "packages" / "core" / "src"))

from server_decorator import ConsumerRegistry, on_event  # noqa: E402
from server_decorator.consumer.adapters.redis_consumer import (  # noqa: E402
    RedisStreamConsumer,
)

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
STREAM = os.environ.get("INTEROP_STREAM", "interop")


async def main() -> int:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis_asyncio.from_url(url)

    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", RedisStreamConsumer(client, stream=STREAM, group="interop", consumer_name="w1"))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 10
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    for got, expected in zip(received, EXPECTED):
        assert got == expected["payload"], f"payload mismatch: {got!r} vs {expected['payload']!r}"

    print(f"consumer: received + matched {len(received)} messages via @on_event.")
    await client.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

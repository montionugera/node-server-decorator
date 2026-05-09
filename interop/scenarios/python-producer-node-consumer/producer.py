"""Python producer: builds QueueMessage exactly as @emit_on_success would, JSON-encodes,
XADDs to a Redis stream. The Node consumer reads + validates."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import redis.asyncio as redis_asyncio

ROOT = Path(__file__).resolve().parents[3]
EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
STREAM = os.environ.get("INTEROP_STREAM", "interop")


async def main() -> None:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis_asyncio.from_url(url)
    for expected in EXPECTED:
        msg = {
            "eventName": expected["eventName"],
            "payload": expected["payload"],
            "timestamp": int(time.time() * 1000),
            "metadata": {
                "className": "OrderService",
                "methodName": "createOrder",
                "topic": "orders",
            },
        }
        await client.xadd(STREAM, {"data": json.dumps(msg, separators=(",", ":"))})
    print(f"producer: wrote {len(EXPECTED)} messages to stream {STREAM}")
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())

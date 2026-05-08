"""Python consumer: reads N messages from a Redis stream, validates each against the
QueueMessage schema, and asserts payload equality (ignoring timestamp) with the shared
expected-payloads fixture."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import redis.asyncio as redis_asyncio
from jsonschema import validate

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "contracts" / "schemas" / "queue-message.schema.json").read_text())
EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
STREAM = os.environ.get("INTEROP_STREAM", "interop")


async def main() -> int:
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    client = redis_asyncio.from_url(url)

    # Wait briefly for producer-written messages to appear.
    deadline = asyncio.get_event_loop().time() + 10
    received: list[dict] = []
    while asyncio.get_event_loop().time() < deadline and len(received) < len(EXPECTED):
        entries = await client.xrange(STREAM, count=len(EXPECTED) * 2)
        received = [json.loads(e[1][b"data"]) for e in entries]
        if len(received) < len(EXPECTED):
            await asyncio.sleep(0.1)

    assert len(received) == len(EXPECTED), (
        f"expected {len(EXPECTED)} messages, got {len(received)}"
    )

    for got, expected in zip(received, EXPECTED):
        validate(instance=got, schema=SCHEMA)
        assert got["eventName"] == expected["eventName"], (
            f"eventName mismatch: {got['eventName']!r} vs {expected['eventName']!r}"
        )
        assert got["payload"] == expected["payload"], (
            f"payload mismatch: {got['payload']!r} vs {expected['payload']!r}"
        )

    print(f"consumer: validated {len(received)} messages against the schema, all match.")
    await client.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

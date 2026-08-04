"""Python consumer using @on_event + KafkaConsumer to receive the Node-produced
Kafka messages, asserting payload equality with the shared fixture."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "packages" / "core" / "src"))

from server_decorator import ConsumerRegistry, KafkaConsumer, on_event  # noqa: E402

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
TOPIC = "OrderService.createOrder"
BROKER = os.environ.get("KAFKA_BROKER", "localhost:9092")


async def main() -> int:
    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", KafkaConsumer(BROKER, topics=[TOPIC], group_id="interop"))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 60
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    for got, expected in zip(received, EXPECTED):
        assert got == expected["payload"], f"payload mismatch: {got!r} vs {expected['payload']!r}"

    print(f"consumer: received + matched {len(received)} messages via @on_event.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

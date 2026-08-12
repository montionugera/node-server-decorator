"""Python consumer using @on_event + BullMQConsumer to receive jobs enqueued by the
Node bullmq Queue producer, asserting payload equality with the shared fixture.

This is the Plan-2 headline: a Node BullMQ producer consumed by Python via the official
`bullmq` package's Worker."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "packages" / "core" / "src"))

from server_decorator import BullMQConsumer, ConsumerRegistry, on_event  # noqa: E402

EXPECTED = json.loads((ROOT / "interop" / "shared" / "expected-payloads.json").read_text())[
    "messages"
]
QUEUE = os.environ.get("INTEROP_QUEUE", "OrderService.createOrder")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


async def main() -> int:
    received: list[dict] = []
    reg = ConsumerRegistry()
    reg.register("c", BullMQConsumer(queue_name=QUEUE, connection=REDIS_URL))

    @on_event("OrderService.createOrder", consumer="c", registry=reg)
    async def handle(payload: dict, meta: dict) -> None:
        received.append(payload)

    await reg.start()
    deadline = asyncio.get_event_loop().time() + 30
    while len(received) < len(EXPECTED) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)
    await reg.stop()

    assert len(received) == len(EXPECTED), f"expected {len(EXPECTED)}, got {len(received)}"
    # BullMQ jobs are FIFO per priority but compare as a set of payloads to be robust
    # to consume ordering across workers.
    expected_payloads = [e["payload"] for e in EXPECTED]
    for got in received:
        assert got in expected_payloads, f"unexpected payload: {got!r}"
    for exp in expected_payloads:
        assert exp in received, f"missing payload: {exp!r}"

    print(f"consumer: received + matched {len(received)} messages via @on_event.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

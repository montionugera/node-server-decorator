import asyncio
from collections.abc import Iterator

import pytest

from server_decorator import (
    ConsumerRegistry,
    InMemoryConsumer,
    on_event,
)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    from server_decorator import global_consumer_registry

    global_consumer_registry.clear()
    yield
    global_consumer_registry.clear()


async def test_on_event_registers_async_handler() -> None:
    got: list = []
    reg = ConsumerRegistry()
    reg.register(
        "c",
        InMemoryConsumer(
            [
                {"eventName": "A.x", "payload": {"n": 1}, "timestamp": 1, "metadata": {}},
            ]
        ),
    )

    @on_event("A.x", consumer="c", registry=reg)
    async def handle(payload, meta):
        got.append(payload)

    await reg.start()
    await asyncio.sleep(0.1)
    await reg.stop()

    assert got == [{"n": 1}]


async def test_on_event_uses_global_registry_by_default() -> None:
    from server_decorator import global_consumer_registry

    got: list = []
    global_consumer_registry.register(
        "c",
        InMemoryConsumer(
            [
                {"eventName": "A.x", "payload": 7, "timestamp": 1, "metadata": {}},
            ]
        ),
    )

    @on_event("A.x", consumer="c")
    async def handle(payload, meta):
        got.append(payload)

    await global_consumer_registry.start()
    await asyncio.sleep(0.1)
    await global_consumer_registry.stop()

    assert got == [7]

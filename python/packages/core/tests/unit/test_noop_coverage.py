"""Unit coverage for NoOpQueueAdapter — drops every message, never raises."""

from __future__ import annotations

from typing import Any

import pytest

from server_decorator.queue.adapters.noop import NoOpQueueAdapter


@pytest.mark.parametrize(
    "message",
    [
        {"eventName": "A.x", "payload": {"n": 1}, "timestamp": 1},
        {"eventName": "A.x", "payload": None, "timestamp": 0, "metadata": {"topic": "t"}},
        {},  # even a malformed envelope is dropped silently
    ],
)
async def test_publish_drops_message_and_returns_none(message: Any) -> None:
    before = dict(message)

    assert await NoOpQueueAdapter().publish(message) is None
    assert message == before  # the message is not mutated


async def test_adapter_is_stateless_across_publishes() -> None:
    adapter = NoOpQueueAdapter()

    for n in range(3):
        assert await adapter.publish({"eventName": "A.x", "payload": n, "timestamp": n}) is None

    assert vars(adapter) == {}  # nothing buffered

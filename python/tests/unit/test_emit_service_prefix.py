"""Tests for service-prefix auto-topic in @emit_on_success."""

from __future__ import annotations

import pytest

import server_decorator.config as cfg
from server_decorator import (
    InMemoryQueueAdapter,
    emit_on_success,
    global_queue_registry,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    global_queue_registry.clear()
    cfg.configure(service=None)
    yield
    cfg.configure(service=None)


async def test_no_service_keeps_two_segment_topic() -> None:
    a = InMemoryQueueAdapter()
    global_queue_registry.register("q", a)

    class OrderService:
        @emit_on_success(use_queue=True, queue="q")
        async def create_order(self, x: int) -> int:
            return x

    await OrderService().create_order(1)
    msg = a.messages["OrderService.create_order"][0]
    assert msg["metadata"]["topic"] == "OrderService.create_order"
    assert "service" not in msg["metadata"]


async def test_service_prefixes_topic_and_stamps_metadata() -> None:
    cfg.configure(service="user-svc")
    a = InMemoryQueueAdapter()
    global_queue_registry.register("q", a)

    class UserService:
        @emit_on_success(use_queue=True, queue="q")
        async def create(self, x: int) -> int:
            return x

    await UserService().create(1)
    msg = a.messages["user-svc.UserService.create"][0]
    assert msg["metadata"]["topic"] == "user-svc.UserService.create"
    assert msg["metadata"]["service"] == "user-svc"

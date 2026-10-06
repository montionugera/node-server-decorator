"""Unit coverage for queue/adapter.py — the global single-queue helpers."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

import server_decorator.queue.adapter as adapter_mod
from server_decorator.queue.adapter import has_global_queue, set_global_queue
from server_decorator.queue.adapters.noop import NoOpQueueAdapter


@pytest.fixture(autouse=True)
def _restore_global_queue() -> Iterator[None]:
    saved = adapter_mod.global_queue
    adapter_mod.global_queue = None
    yield
    adapter_mod.global_queue = saved


def test_has_global_queue_is_false_when_unset() -> None:
    assert adapter_mod.global_queue is None
    assert has_global_queue() is False


def test_set_global_queue_installs_adapter() -> None:
    adapter = NoOpQueueAdapter()

    assert set_global_queue(adapter) is None

    assert adapter_mod.global_queue is adapter
    assert has_global_queue() is True


def test_set_global_queue_replaces_previous_adapter() -> None:
    first, second = NoOpQueueAdapter(), NoOpQueueAdapter()

    set_global_queue(first)
    set_global_queue(second)

    assert adapter_mod.global_queue is second
    assert has_global_queue() is True


def test_public_surface() -> None:
    assert set(adapter_mod.__all__) == {
        "QueueAdapter",
        "global_queue",
        "set_global_queue",
        "has_global_queue",
    }

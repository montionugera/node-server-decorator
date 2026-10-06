"""Unit tests for QueueRegistry: registration, default selection, lookup misses, topic routing."""

from __future__ import annotations

from typing import Any

import pytest

from server_decorator.queue.message import QueueMessage
from server_decorator.queue.registry import QueueConfig, QueueRegistry


class _Recorder:
    def __init__(self) -> None:
        self.messages: list[QueueMessage] = []

    async def publish(self, message: QueueMessage) -> None:
        self.messages.append(message)


def _msg(**metadata: Any) -> QueueMessage:
    msg: dict[str, Any] = {"eventName": "E", "payload": 1, "timestamp": 0}
    if metadata:
        msg["metadata"] = dict(metadata)
    return msg  # type: ignore[return-value]


def test_register_bare_adapter_wraps_it_in_default_config() -> None:
    reg = QueueRegistry()
    adapter = _Recorder()
    reg.register("a", adapter)

    cfg = reg.get("a")
    assert isinstance(cfg, QueueConfig)
    assert cfg.adapter is adapter
    assert cfg.default_topic == "default"
    assert cfg.priority == 0


def test_register_queue_config_is_stored_as_is() -> None:
    reg = QueueRegistry()
    cfg = QueueConfig(adapter=_Recorder(), default_topic="orders", priority=3)
    reg.register("a", cfg)
    assert reg.get("a") is cfg


def test_first_registered_queue_is_the_default_and_stays_so() -> None:
    reg = QueueRegistry()
    first, second = _Recorder(), _Recorder()
    reg.register("first", first)
    reg.register("second", second)

    assert reg.get().adapter is first
    assert reg.get(None).adapter is first


def test_set_default_switches_the_default() -> None:
    reg = QueueRegistry()
    first, second = _Recorder(), _Recorder()
    reg.register("first", first)
    reg.register("second", second)

    reg.set_default("second")
    assert reg.get().adapter is second


def test_set_default_unknown_name_raises_and_keeps_default() -> None:
    reg = QueueRegistry()
    first = _Recorder()
    reg.register("first", first)

    with pytest.raises(KeyError, match="'nope' not registered"):
        reg.set_default("nope")
    assert reg.get().adapter is first


def test_get_unknown_name_raises_key_error() -> None:
    reg = QueueRegistry()
    reg.register("first", _Recorder())
    with pytest.raises(KeyError, match="'missing' not registered"):
        reg.get("missing")


def test_get_on_empty_registry_raises_runtime_error() -> None:
    with pytest.raises(RuntimeError, match="no queues registered"):
        QueueRegistry().get()


def test_clear_drops_queues_and_default() -> None:
    reg = QueueRegistry()
    reg.register("first", _Recorder())
    reg.clear()

    with pytest.raises(RuntimeError, match="no queues registered"):
        reg.get()
    with pytest.raises(KeyError):
        reg.get("first")

    # After a clear the next registration becomes the default again.
    replacement = _Recorder()
    reg.register("later", replacement)
    assert reg.get().adapter is replacement


def test_re_registering_a_name_replaces_the_adapter() -> None:
    reg = QueueRegistry()
    old, new = _Recorder(), _Recorder()
    reg.register("q", old)
    reg.register("q", new)
    assert reg.get("q").adapter is new
    assert reg.get().adapter is new


async def test_publish_topic_priority_explicit_then_metadata_then_default_topic() -> None:
    reg = QueueRegistry()
    adapter = _Recorder()
    reg.register("q", QueueConfig(adapter=adapter, default_topic="fallback"))

    await reg.publish(_msg(topic="from-meta"), topic="explicit")
    await reg.publish(_msg(topic="from-meta"))
    await reg.publish(_msg(className="Svc"))
    await reg.publish(_msg())
    await reg.publish(_msg(topic=""), topic="")

    topics = [m["metadata"]["topic"] for m in adapter.messages]
    assert topics == ["explicit", "from-meta", "fallback", "fallback", "fallback"]
    # Other metadata keys survive the topic stamp.
    assert adapter.messages[2]["metadata"]["className"] == "Svc"


async def test_publish_does_not_mutate_the_callers_metadata_dict() -> None:
    reg = QueueRegistry()
    adapter = _Recorder()
    reg.register("q", adapter)

    meta: dict[str, Any] = {"className": "Svc"}
    message: Any = {"eventName": "E", "payload": 1, "timestamp": 0, "metadata": meta}
    await reg.publish(message, topic="t")

    assert meta == {"className": "Svc"}
    assert adapter.messages[0]["metadata"] == {"className": "Svc", "topic": "t"}


async def test_publish_routes_to_the_named_queue_only() -> None:
    reg = QueueRegistry()
    a, b = _Recorder(), _Recorder()
    reg.register("a", a)
    reg.register("b", b)

    await reg.publish(_msg(), queue_name="b", topic="t")

    assert a.messages == []
    assert len(b.messages) == 1


async def test_publish_to_unknown_queue_raises_and_publishes_nothing() -> None:
    reg = QueueRegistry()
    a = _Recorder()
    reg.register("a", a)

    with pytest.raises(KeyError):
        await reg.publish(_msg(), queue_name="ghost")
    assert a.messages == []


async def test_publish_propagates_adapter_errors() -> None:
    class _Broken:
        async def publish(self, message: QueueMessage) -> None:
            raise ConnectionError("down")

    reg = QueueRegistry()
    reg.register("q", _Broken())
    with pytest.raises(ConnectionError, match="down"):
        await reg.publish(_msg())

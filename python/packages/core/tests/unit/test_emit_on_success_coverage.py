"""Coverage-gap tests for @emit_on_success: failure isolation of listeners / transform /
queue publish, default-queue routing, trace propagation and the executor loop helpers."""

from __future__ import annotations

import asyncio
import importlib
from collections.abc import Iterator
from typing import Any

import pytest

import server_decorator.logger as logger_mod
from server_decorator import (
    emit_on_success,
    emit_on_success_class,
    global_emitter,
    global_queue_registry,
)
from server_decorator.config import configure
from server_decorator.decorators.trace import TraceContext, set_active_trace_context
from server_decorator.queue.message import QueueMessage
from server_decorator.queue.registry import QueueConfig

# The package re-exports the decorator functions under the submodules' names, so the
# module objects themselves have to be fetched explicitly.
emit_mod = importlib.import_module("server_decorator.decorators.emit_on_success")
trace_mod = importlib.import_module("server_decorator.decorators.trace")


class _Recorder:
    """Queue adapter that keeps every published envelope in order."""

    def __init__(self) -> None:
        self.published: list[QueueMessage] = []

    async def publish(self, message: QueueMessage) -> None:
        self.published.append(message)


class _Log:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, msg: object) -> None:
        self.errors.append(str(msg))

    def debug(self, msg: object) -> None: ...
    def info(self, msg: object) -> None: ...
    def warn(self, msg: object) -> None: ...


@pytest.fixture(autouse=True)
def _reset_registry() -> Iterator[None]:
    global_queue_registry.clear()
    yield
    global_queue_registry.clear()


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> _Log:
    recorder = _Log()
    monkeypatch.setattr(logger_mod, "global_logger", recorder)
    return recorder


def _drain_executor() -> None:
    # Single worker: once this no-op has run, every earlier submission has finished.
    emit_mod._EMIT_EXECUTOR.submit(lambda: None).result(timeout=5)


# ---------------------------------------------------------------- failure isolation


async def test_raising_listener_is_logged_and_queue_still_published(log: _Log) -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)

    def bad_listener(payload: Any) -> None:
        raise RuntimeError("listener exploded")

    global_emitter.on("Order.place", bad_listener)
    try:

        class Order:
            @emit_on_success(use_queue=True, queue="mem")
            async def place(self) -> dict[str, int]:
                return {"id": 1}

        assert await Order().place() == {"id": 1}
    finally:
        global_emitter.off("Order.place", bad_listener)

    assert len(log.errors) == 1
    assert log.errors[0].startswith("Failed to emit event Order.place: RuntimeError(")
    assert "listener exploded" in log.errors[0]
    assert [m["payload"] for m in adapter.published] == [{"id": 1}]


async def test_raising_transform_emits_nothing_and_keeps_the_result(log: _Log) -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)
    received: list[Any] = []
    global_emitter.on("Order.cancel", received.append)

    def transform(result: Any) -> Any:
        raise ZeroDivisionError("bad transform")

    try:

        class Order:
            @emit_on_success(use_queue=True, queue="mem", transform=transform)
            async def cancel(self) -> str:
                return "cancelled"

        assert await Order().cancel() == "cancelled"
    finally:
        global_emitter.off("Order.cancel", received.append)

    assert received == []
    assert adapter.published == []
    assert len(log.errors) == 1
    assert "transform failed for Order.cancel; nothing emitted" in log.errors[0]


async def test_queue_publish_failure_is_logged_not_raised(log: _Log) -> None:
    class Order:
        # No queue is registered at all: the registry raises inside publish.
        @emit_on_success(use_queue=True, use_events=False)
        async def place(self) -> int:
            return 5

    assert await Order().place() == 5
    assert len(log.errors) == 1
    assert log.errors[0].startswith("Failed to publish to queue: RuntimeError(")
    assert "no queues registered" in log.errors[0]


async def test_unknown_named_queue_is_logged_not_raised(log: _Log) -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)

    class Order:
        @emit_on_success(use_queue=True, use_events=False, queue="ghost")
        async def place(self) -> int:
            return 5

    assert await Order().place() == 5
    assert adapter.published == []
    assert len(log.errors) == 1 and "ghost" in log.errors[0]


async def test_failing_method_emits_nothing() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)
    received: list[Any] = []
    global_emitter.on("Order.fail", received.append)
    try:

        class Order:
            @emit_on_success(use_queue=True, queue="mem")
            async def fail(self) -> None:
                raise PermissionError("denied")

        with pytest.raises(PermissionError, match="denied"):
            await Order().fail()
    finally:
        global_emitter.off("Order.fail", received.append)
    assert received == []
    assert adapter.published == []


# ---------------------------------------------------------------- queue routing


async def test_default_queue_and_default_topic_when_nothing_is_specified() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", QueueConfig(adapter=adapter, default_topic="fallback"))

    class Order:
        @emit_on_success(use_queue=True, use_events=False, queue_metadata={"tenant": "t1"})
        async def place(self) -> dict[str, int]:
            return {"id": 1}

    await Order().place()

    [msg] = adapter.published
    assert msg["eventName"] == "Order.place"
    assert msg["payload"] == {"id": 1}
    assert isinstance(msg["timestamp"], int) and msg["timestamp"] > 0
    meta = msg["metadata"]
    # No queue / topic / service configured: the registry's default_topic applies.
    assert meta["topic"] == "fallback"
    assert meta["className"] == "Order"
    assert meta["methodName"] == "place"
    assert meta["tenant"] == "t1"
    assert "service" not in meta
    assert "traceparent" not in meta


async def test_event_name_override_changes_event_but_not_the_auto_topic() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)
    configure(service="billing")
    received: list[Any] = []
    global_emitter.on("order.placed", received.append)
    try:

        class Order:
            @emit_on_success(use_queue=True, event_name="order.placed", transform=lambda r: r["id"])
            async def place(self) -> dict[str, int]:
                return {"id": 9}

        assert await Order().place() == {"id": 9}
    finally:
        global_emitter.off("order.placed", received.append)

    assert received == [9]
    [msg] = adapter.published
    assert msg["eventName"] == "order.placed"
    assert msg["payload"] == 9
    assert msg["metadata"]["topic"] == "billing.Order.place"
    assert msg["metadata"]["service"] == "billing"


async def test_active_trace_is_propagated_with_tracestate() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)

    class Order:
        @emit_on_success(use_queue=True, use_events=False, queue="mem")
        async def place(self) -> int:
            return 1

    ctx = TraceContext(trace_id="a" * 32, span_id="b" * 16, sampled=False, tracestate="vendor=1")
    token = set_active_trace_context(ctx)
    try:
        await Order().place()
    finally:
        trace_mod._ACTIVE_TRACE_CONTEXT.reset(token)

    plain = TraceContext(trace_id="c" * 32, span_id="d" * 16)
    token = set_active_trace_context(plain)
    try:
        await Order().place()
    finally:
        trace_mod._ACTIVE_TRACE_CONTEXT.reset(token)

    with_state, without_state = (m["metadata"] for m in adapter.published)
    assert with_state["traceparent"] == f"00-{'a' * 32}-{'b' * 16}-00"
    assert with_state["tracestate"] == "vendor=1"
    assert without_state["traceparent"] == f"00-{'c' * 32}-{'d' * 16}-01"
    assert "tracestate" not in without_state


# ---------------------------------------------------------------- sync paths


async def test_sync_method_inside_a_running_loop_emits_via_background_task() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)

    class Order:
        @emit_on_success(use_queue=True, use_events=False, queue="mem")
        def place(self) -> str:
            return "sync"

    assert Order().place() == "sync"
    # Fire-and-forget: nothing is published until the loop gets a turn.
    assert adapter.published == []
    for _ in range(10):
        await asyncio.sleep(0)
        if adapter.published:
            break
    assert [m["payload"] for m in adapter.published] == ["sync"]
    await asyncio.sleep(0)
    assert emit_mod._BACKGROUND_TASKS == set()


def test_sync_method_outside_a_loop_emits_on_the_executor_with_caller_context() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)
    received: list[Any] = []
    global_emitter.on("Order.place", received.append)

    class Order:
        @emit_on_success(use_queue=True, queue="mem")
        def place(self, n: int) -> int:
            return n

    ctx = TraceContext(trace_id="e" * 32, span_id="f" * 16)
    token = set_active_trace_context(ctx)
    try:
        assert [Order().place(n) for n in (1, 2, 3)] == [1, 2, 3]
    finally:
        trace_mod._ACTIVE_TRACE_CONTEXT.reset(token)
        _drain_executor()
        global_emitter.off("Order.place", received.append)

    # One worker, one long-lived loop: order is preserved across messages.
    assert received == [1, 2, 3]
    assert [m["payload"] for m in adapter.published] == [1, 2, 3]
    assert {m["metadata"]["traceparent"] for m in adapter.published} == {
        f"00-{'e' * 32}-{'f' * 16}-01"
    }


def test_sync_method_failure_on_the_executor_is_logged(log: _Log) -> None:
    class Order:
        @emit_on_success(use_queue=True, use_events=False)
        def place(self) -> str:
            return "ok"

    assert Order().place() == "ok"
    _drain_executor()
    assert len(log.errors) == 1
    assert "no queues registered" in log.errors[0]


# ---------------------------------------------------------------- executor loop helpers


def test_run_on_emit_loop_creates_reuses_and_replaces_a_closed_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(emit_mod, "_EMIT_LOOP", None)
    ran: list[int] = []

    async def job(n: int) -> None:
        ran.append(n)

    emit_mod._run_on_emit_loop(job(1))
    first = emit_mod._EMIT_LOOP
    assert first is not None and not first.is_closed()

    emit_mod._run_on_emit_loop(job(2))
    assert emit_mod._EMIT_LOOP is first

    first.close()
    emit_mod._run_on_emit_loop(job(3))
    second = emit_mod._EMIT_LOOP
    assert second is not None and second is not first and not second.is_closed()
    assert ran == [1, 2, 3]
    second.close()


def test_close_emit_loop_is_idempotent_and_tolerates_no_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(emit_mod, "_EMIT_LOOP", None)
    emit_mod._close_emit_loop()
    assert emit_mod._EMIT_LOOP is None

    loop = asyncio.new_event_loop()
    monkeypatch.setattr(emit_mod, "_EMIT_LOOP", loop)
    emit_mod._close_emit_loop()
    assert loop.is_closed()
    # A second call on the already-closed loop is a no-op.
    emit_mod._close_emit_loop()
    assert loop.is_closed()


# ---------------------------------------------------------------- class form


async def test_class_form_applies_options_and_respects_exclude() -> None:
    adapter = _Recorder()
    global_queue_registry.register("mem", adapter)

    @emit_on_success_class(
        use_queue=True, use_events=False, queue="mem", topic="orders", exclude=("quiet",)
    )
    class Order:
        async def place(self) -> int:
            return 1

        async def quiet(self) -> int:
            return 2

        async def _internal(self) -> int:
            return 3

    order = Order()
    assert (await order.place(), await order.quiet(), await order._internal()) == (1, 2, 3)
    [msg] = adapter.published
    assert msg["eventName"] == "Order.place"
    assert msg["metadata"]["topic"] == "orders"

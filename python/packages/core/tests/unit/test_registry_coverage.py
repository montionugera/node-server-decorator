"""Unit coverage for consumer/registry.py — default routing, lifecycle error paths,
log fallbacks and the CONSUMER trace span."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from typing import Any

import pytest

from server_decorator.consumer.adapter import Dispatch
from server_decorator.consumer.inmemory import InMemoryConsumer
from server_decorator.consumer.registry import (
    ConsumerRegistry,
    _on_task_done,
    global_consumer_registry,
)
from server_decorator.decorators.trace import (
    TraceSpan,
    get_active_trace_context,
    set_span_exporter,
)

_LOGGER = "server_decorator.consumer"
_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
_PARENT_SPAN = "b7ad6b7169203331"


def _envelope(event_name: str, payload: object, **metadata: Any) -> dict[str, Any]:
    return {"eventName": event_name, "payload": payload, "timestamp": 1, "metadata": metadata}


class _StubAdapter:
    """Adapter whose run() blocks on an event; records lifecycle calls."""

    def __init__(self) -> None:
        self.dispatch: Dispatch | None = None
        self.stopped = 0
        self._stop = asyncio.Event()

    async def run(self, dispatch: Dispatch) -> None:
        self.dispatch = dispatch
        await self._stop.wait()

    async def stop(self) -> None:
        self.stopped += 1
        self._stop.set()


class _DeafAdapter(_StubAdapter):
    """run() ignores stop() — only cancellation ends it."""

    def __init__(self) -> None:
        super().__init__()
        self.cancelled = False

    async def run(self, dispatch: Dispatch) -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    async def stop(self) -> None:
        self.stopped += 1


@pytest.fixture
def spans() -> Iterator[list[TraceSpan]]:
    exported: list[TraceSpan] = []
    set_span_exporter(exported.append)
    yield exported
    set_span_exporter(None)


# --- registration / routing -------------------------------------------------


def test_first_registered_consumer_becomes_default() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))
    reg.register("b", InMemoryConsumer([]))

    def handler(payload: Any, metadata: dict[str, Any]) -> None:
        return None

    reg.on("A.x", handler)  # no consumer= → default

    assert reg._default == "a"
    assert reg._consumers["a"].handlers == {"A.x": handler}
    assert reg._consumers["b"].handlers == {}


def test_set_default_reroutes_unqualified_handlers() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))
    reg.register("b", InMemoryConsumer([]))

    def handler(payload: Any, metadata: dict[str, Any]) -> None:
        return None

    reg.set_default("b")
    reg.on("A.x", handler)

    assert reg._consumers["b"].handlers == {"A.x": handler}
    assert reg._consumers["a"].handlers == {}


def test_set_default_unknown_consumer_raises_and_keeps_default() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))

    with pytest.raises(KeyError, match="ghost"):
        reg.set_default("ghost")

    assert reg._default == "a"


def test_on_without_any_consumer_raises() -> None:
    with pytest.raises(KeyError, match="not registered"):
        ConsumerRegistry().on("A.x", lambda p, m: None)


def test_on_unknown_named_consumer_raises() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))

    with pytest.raises(KeyError, match="ghost"):
        reg.on("A.x", lambda p, m: None, consumer="ghost")

    assert reg._consumers["a"].handlers == {}


def test_reregistering_a_name_replaces_adapter_and_drops_handlers() -> None:
    reg = ConsumerRegistry()
    first, second = InMemoryConsumer([]), InMemoryConsumer([])
    reg.register("a", first)
    reg.on("A.x", lambda p, m: None)

    reg.register("a", second)

    assert reg._consumers["a"].adapter is second
    assert reg._consumers["a"].handlers == {}
    assert reg._default == "a"


def test_later_handler_for_same_event_wins() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))

    def old(payload: Any, metadata: dict[str, Any]) -> None:
        return None

    def new(payload: Any, metadata: dict[str, Any]) -> None:
        return None

    reg.on("A.x", old)
    reg.on("A.x", new)

    assert reg._consumers["a"].handlers["A.x"] is new


def test_clear_drops_consumers_default_and_tasks() -> None:
    reg = ConsumerRegistry()
    reg.register("a", InMemoryConsumer([]))

    reg.clear()

    assert reg._consumers == {}
    assert reg._default is None
    assert reg._tasks == []
    with pytest.raises(KeyError):
        reg.on("A.x", lambda p, m: None)


def test_global_registry_is_a_consumer_registry() -> None:
    assert isinstance(global_consumer_registry, ConsumerRegistry)


# --- dispatch ---------------------------------------------------------------


async def test_invalid_envelope_without_hook_is_logged_and_skipped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))
    called: list[Any] = []
    reg.on("A.x", lambda p, m: called.append(p))
    dispatch = reg._dispatch_for("c")

    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        assert await dispatch("not-an-object") is None  # returns normally → acked

    assert called == []
    messages = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(messages) == 1
    assert "invalid envelope dropped" in messages[0] and "str" in messages[0]


async def test_invalid_envelope_hook_receives_raw_and_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[tuple[Any, Exception]] = []
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]), on_invalid=lambda raw, err: seen.append((raw, err)))
    dispatch = reg._dispatch_for("c")
    raw = {"eventName": "", "payload": 1, "timestamp": 1}

    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        await dispatch(raw)

    assert len(seen) == 1
    assert seen[0][0] is raw
    assert isinstance(seen[0][1], ValueError) and "eventName" in str(seen[0][1])
    assert caplog.records == []  # the hook replaces the log fallback


async def test_unhandled_event_without_hook_is_debug_logged_and_skipped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))
    called: list[Any] = []
    reg.on("A.x", lambda p, m: called.append(p))
    dispatch = reg._dispatch_for("c")

    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        assert await dispatch(_envelope("B.y", 1)) is None

    assert called == []
    assert any(
        r.levelno == logging.DEBUG and "no handler for event B.y" in r.getMessage()
        for r in caplog.records
    )


async def test_async_handler_is_awaited_and_missing_metadata_defaults_to_empty() -> None:
    got: list[tuple[Any, Any]] = []
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))

    async def handler(payload: Any, metadata: dict[str, Any]) -> None:
        await asyncio.sleep(0)
        got.append((payload, metadata))

    reg.on("A.x", handler)

    await reg._dispatch_for("c")({"eventName": "A.x", "payload": 0, "timestamp": 1})

    assert got == [(0, {})]


@pytest.mark.parametrize("is_async", [False, True])
async def test_handler_error_propagates_so_adapter_does_not_ack(is_async: bool) -> None:
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))

    def sync_handler(payload: Any, metadata: dict[str, Any]) -> None:
        raise RuntimeError("handler boom")

    async def async_handler(payload: Any, metadata: dict[str, Any]) -> None:
        raise RuntimeError("handler boom")

    reg.on("A.x", async_handler if is_async else sync_handler)

    with pytest.raises(RuntimeError, match="handler boom"):
        await reg._dispatch_for("c")(_envelope("A.x", 1))


async def test_traceparent_opens_consumer_span_as_child_of_producer(
    spans: list[TraceSpan],
) -> None:
    active: list[Any] = []
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))
    reg.on("A.x", lambda p, m: active.append(get_active_trace_context()))

    await reg._dispatch_for("c")(
        _envelope("A.x", 1, traceparent=f"00-{_TRACE_ID}-{_PARENT_SPAN}-01", tracestate="vendor=1")
    )

    assert len(spans) == 1
    span = spans[0]
    assert span.name == "consume A.x"
    assert span.trace_id == _TRACE_ID
    assert span.parent_span_id == _PARENT_SPAN
    assert span.span_id != _PARENT_SPAN
    assert span.attributes["span.kind"] == "CONSUMER"
    assert span.status == "OK"
    # the span is active while the handler runs, and gone afterwards
    assert active[0] is not None
    assert active[0].trace_id == _TRACE_ID and active[0].span_id == span.span_id
    assert get_active_trace_context() is None


async def test_handler_error_marks_consumer_span_error(spans: list[TraceSpan]) -> None:
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))

    async def handler(payload: Any, metadata: dict[str, Any]) -> None:
        raise RuntimeError("handler boom")

    reg.on("A.x", handler)

    with pytest.raises(RuntimeError, match="handler boom"):
        await reg._dispatch_for("c")(
            _envelope("A.x", 1, traceparent=f"00-{_TRACE_ID}-{_PARENT_SPAN}-01")
        )

    assert [s.status for s in spans] == ["ERROR"]


@pytest.mark.parametrize("traceparent", [None, "", "garbage", f"00-{_TRACE_ID}-short-01"])
async def test_absent_or_malformed_traceparent_opens_no_span(
    spans: list[TraceSpan], traceparent: Any
) -> None:
    got: list[Any] = []
    reg = ConsumerRegistry()
    reg.register("c", InMemoryConsumer([]))
    reg.on("A.x", lambda p, m: got.append(p))
    metadata = {} if traceparent is None else {"traceparent": traceparent}

    await reg._dispatch_for("c")(_envelope("A.x", "p", **metadata))

    assert got == ["p"]  # handler still runs
    assert spans == []


# --- lifecycle --------------------------------------------------------------


async def test_start_runs_every_consumer_and_stop_stops_each_once() -> None:
    a, b = _StubAdapter(), _StubAdapter()
    reg = ConsumerRegistry()
    reg.register("a", a)
    reg.register("b", b)

    await reg.start()
    await asyncio.sleep(0)

    assert len(reg._tasks) == 2
    assert a.dispatch is not None and b.dispatch is not None
    assert not any(t.done() for t in reg._tasks)

    tasks = list(reg._tasks)
    await reg.stop()

    assert (a.stopped, b.stopped) == (1, 1)
    assert all(t.done() and not t.cancelled() for t in tasks)
    assert reg._tasks == []


async def test_stop_without_start_stops_adapters_and_is_safe() -> None:
    adapter = _StubAdapter()
    reg = ConsumerRegistry()
    reg.register("a", adapter)

    await reg.stop()

    assert adapter.stopped == 1
    assert reg._tasks == []


async def test_stop_cancels_adapter_that_does_not_exit_within_timeout() -> None:
    adapter = _DeafAdapter()
    reg = ConsumerRegistry()
    reg.register("a", adapter)
    await reg.start()
    await asyncio.sleep(0)
    task = reg._tasks[0]

    await asyncio.wait_for(reg.stop(), timeout=5)  # must not hang or raise

    assert adapter.stopped == 1
    assert adapter.cancelled is True
    assert task.cancelled()
    assert reg._tasks == []


async def test_stop_tolerates_task_that_was_already_cancelled() -> None:
    adapter = _DeafAdapter()
    reg = ConsumerRegistry()
    reg.register("a", adapter)
    await reg.start()
    await asyncio.sleep(0)
    task = reg._tasks[0]
    task.cancel()
    await asyncio.sleep(0)

    await asyncio.wait_for(reg.stop(), timeout=5)  # CancelledError is swallowed

    assert task.cancelled()
    assert reg._tasks == []


async def test_crashed_consumer_task_is_logged_and_stop_surfaces_the_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Crashing(_StubAdapter):
        async def run(self, dispatch: Dispatch) -> None:
            raise RuntimeError("adapter crashed")

    reg = ConsumerRegistry()
    reg.register("a", _Crashing())

    with caplog.at_level(logging.ERROR, logger=_LOGGER):
        await reg.start()
        await asyncio.sleep(0.01)

    crashed = [r for r in caplog.records if "terminated with exception" in r.getMessage()]
    assert len(crashed) == 1
    assert isinstance(crashed[0].exc_info[1], RuntimeError)  # type: ignore[index]

    with pytest.raises(RuntimeError, match="adapter crashed"):
        await reg.stop()


async def test_on_task_done_ignores_cancelled_and_clean_tasks(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def forever() -> None:
        await asyncio.Event().wait()

    async def clean() -> None:
        return None

    cancelled = asyncio.create_task(forever())
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    finished = asyncio.create_task(clean())
    await finished

    with caplog.at_level(logging.DEBUG, logger=_LOGGER):
        assert _on_task_done(cancelled) is None
        assert _on_task_done(finished) is None

    assert caplog.records == []

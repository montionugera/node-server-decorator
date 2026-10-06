"""Regression tests for the tracing hardening fixes (quality-gate baseline)."""

import asyncio
import importlib

import pytest

from server_decorator import (
    ConsumerRegistry,
    InMemoryConsumer,
    InMemoryQueueAdapter,
    emit_on_success,
    get_active_trace_context,
    global_queue_registry,
    parse_traceparent,
    set_span_exporter,
    trace,
    traced_class,
)
from server_decorator.decorators.trace import TraceContext, set_active_trace_context

# The package re-exports the `emit_on_success` function under the module's name.
emit_mod = importlib.import_module("server_decorator.decorators.emit_on_success")

PRODUCER_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PRODUCER_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{PRODUCER_TRACE_ID}-{PRODUCER_SPAN_ID}-01"


@pytest.fixture
def spans():
    captured = []
    set_span_exporter(captured.append)
    global_queue_registry.clear()
    yield captured
    set_span_exporter(None)
    global_queue_registry.clear()


class TestParseTraceparentStrictness:
    @pytest.mark.parametrize(
        "header",
        [
            f"01-{PRODUCER_TRACE_ID}-{PRODUCER_SPAN_ID}-01",
            "cc-" + "0" * 32 + "-" + "0" * 16 + "-01",
            "cc-" + "0" * 32 + f"-{PRODUCER_SPAN_ID}-01",
            f"00-{PRODUCER_TRACE_ID.upper()}-{PRODUCER_SPAN_ID}-01",
        ],
    )
    def test_rejects(self, header):
        assert parse_traceparent(header) is None


class TestSyncEmitOutsideLoop:
    def test_sync_emit_without_running_loop_carries_traceparent(self, spans):
        adapter = InMemoryQueueAdapter()
        global_queue_registry.register("orders", adapter)

        @trace(name="orders.create")
        @emit_on_success(queue="orders", topic="order.created", use_queue=True, use_events=False)
        def create_order(order_id):
            return {"id": order_id}

        create_order("ord-1")
        # Drain the single-worker executor: a no-op queued behind the emit.
        emit_mod._EMIT_EXECUTOR.submit(lambda: None).result(timeout=5)

        messages = adapter.messages.get("order.created", [])
        assert len(messages) == 1
        parsed = parse_traceparent(messages[0]["metadata"].get("traceparent"))
        assert parsed is not None
        assert parsed.trace_id == spans[0].trace_id
        assert parsed.span_id == spans[0].span_id
        # The caller thread's context is untouched.
        assert get_active_trace_context() is None


class TestConsumerSpan:
    def _dispatch(self, handler):
        registry = ConsumerRegistry()
        registry.register("c", InMemoryConsumer([]))
        registry.on("order.created", handler, consumer="c")
        return registry._dispatch_for("c")

    def _message(self, traceparent=TRACEPARENT):
        return {
            "eventName": "order.created",
            "payload": {"id": "ord-1"},
            "timestamp": 1,
            "metadata": {"traceparent": traceparent, "tracestate": "congo=t61rcWkgMzE"},
        }

    async def test_exports_consumer_span_and_parents_resolve(self, spans):
        seen = {}

        @trace(name="worker.handle")
        async def work():
            ctx = get_active_trace_context()
            seen["tracestate"] = ctx.tracestate if ctx else None

        async def handler(payload, metadata):
            await work()

        await self._dispatch(handler)(self._message())

        assert len(spans) == 2
        known = {PRODUCER_SPAN_ID, *(s.span_id for s in spans)}
        for span in spans:
            assert span.trace_id == PRODUCER_TRACE_ID
            assert span.parent_span_id in known

        consumer_span = next(s for s in spans if s.attributes.get("span.kind") == "CONSUMER")
        assert consumer_span.name == "consume order.created"
        assert consumer_span.parent_span_id == PRODUCER_SPAN_ID
        assert consumer_span.span_id != PRODUCER_SPAN_ID
        assert consumer_span.status == "OK"

        handler_span = next(s for s in spans if s.name == "worker.handle")
        assert handler_span.parent_span_id == consumer_span.span_id
        assert seen["tracestate"] == "congo=t61rcWkgMzE"

    async def test_handler_failure_marks_consumer_span_error(self, spans):
        def handler(payload, metadata):
            raise ValueError("handler failed")

        with pytest.raises(ValueError, match="handler failed"):
            await self._dispatch(handler)(self._message())

        assert len(spans) == 1
        assert spans[0].status == "ERROR"
        assert spans[0].attributes["exception.type"] == "ValueError"

    async def test_preexisting_context_survives_dispatch(self, spans):
        outer = TraceContext(trace_id="a" * 32, span_id="b" * 16)
        set_active_trace_context(outer)
        try:
            await self._dispatch(lambda payload, metadata: None)(self._message())
            assert get_active_trace_context() is outer
        finally:
            set_active_trace_context(None)

    async def test_invalid_traceparent_runs_untraced(self, spans):
        seen = {}

        def handler(payload, metadata):
            seen["ctx"] = get_active_trace_context()

        await self._dispatch(handler)(self._message("ff-bad"))

        assert seen["ctx"] is None
        assert spans == []


class TestGenerators:
    async def test_async_generator_span_covers_iteration_and_records_error(self, spans):
        inside = []

        @trace(name="agen")
        async def agen():
            inside.append(get_active_trace_context())
            await asyncio.sleep(0.02)
            yield 1
            inside.append(get_active_trace_context())
            raise ValueError("mid-stream")

        items = []
        with pytest.raises(ValueError, match="mid-stream"):
            async for item in agen():
                items.append(item)
                # The consumer of the stream is outside the span.
                assert get_active_trace_context() is None

        assert items == [1]
        assert len(spans) == 1
        span = spans[0]
        assert span.status == "ERROR"
        assert span.attributes["exception.type"] == "ValueError"
        assert span.duration_ms >= 15
        assert [c.span_id for c in inside] == [span.span_id, span.span_id]

    async def test_async_generator_success_and_nested_span(self, spans):
        @trace(name="child")
        async def child():
            return 1

        @trace(name="agen")
        async def agen():
            yield await child()
            yield 2

        assert [i async for i in agen()] == [1, 2]
        by_name = {s.name: s for s in spans}
        assert by_name["agen"].status == "OK"
        assert by_name["child"].parent_span_id == by_name["agen"].span_id
        assert by_name["child"].trace_id == by_name["agen"].trace_id

    async def test_async_generator_early_close_ends_span_ok(self, spans):
        cleaned = []

        @trace(name="agen")
        async def agen():
            try:
                yield 1
                yield 2
            finally:
                cleaned.append(get_active_trace_context())

        it = agen()
        assert await it.__anext__() == 1
        assert spans == []
        await it.aclose()

        assert len(spans) == 1
        assert spans[0].status == "OK"
        assert cleaned[0].span_id == spans[0].span_id

    async def test_async_generator_asend_and_athrow_reach_the_body(self, spans):
        @trace(name="agen")
        async def agen():
            got = yield "first"
            try:
                yield got
            except KeyError:
                yield "caught"

        it = agen()
        assert await it.__anext__() == "first"
        assert await it.asend("sent") == "sent"
        assert await it.athrow(KeyError("x")) == "caught"
        await it.aclose()
        assert spans[0].status == "OK"

    def test_sync_generator_span_covers_iteration_and_records_error(self, spans):
        inside = []

        @trace(name="gen")
        def gen():
            inside.append(get_active_trace_context())
            yield 1
            inside.append(get_active_trace_context())
            raise ValueError("mid-stream")

        items = []
        with pytest.raises(ValueError, match="mid-stream"):
            for item in gen():
                items.append(item)
                assert get_active_trace_context() is None

        assert items == [1]
        assert len(spans) == 1
        assert spans[0].status == "ERROR"
        assert [c.span_id for c in inside] == [spans[0].span_id, spans[0].span_id]

    def test_sync_generator_send_throw_return_and_close(self, spans):
        @trace(name="gen")
        def gen():
            got = yield "first"
            try:
                yield got
            except KeyError:
                yield "caught"
            return "done"

        def outer():
            result = yield from gen()
            yield result

        it = outer()
        assert next(it) == "first"
        assert it.send("sent") == "sent"
        assert it.throw(KeyError("x")) == "caught"
        assert next(it) == "done"
        assert spans[0].status == "OK"

        early = gen()
        next(early)
        early.close()
        assert len(spans) == 2
        assert spans[1].status == "OK"

    def test_traced_class_wraps_generator_methods(self, spans):
        @traced_class()
        class Streamer:
            def stream(self):
                yield get_active_trace_context()

        (ctx,) = list(Streamer().stream())
        assert ctx is not None
        assert ctx.span_id == spans[0].span_id


class TestFailureStatus:
    async def test_cancelled_coroutine_exports_error_span(self, spans):
        @trace(name="slow")
        async def slow():
            await asyncio.sleep(10)

        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(slow(), timeout=0.01)

        assert [(s.name, s.status) for s in spans] == [("slow", "ERROR")]
        assert spans[0].attributes["exception.type"] == "CancelledError"

    def test_sync_base_exception_exports_error_span(self, spans):
        @trace(name="interrupted")
        def interrupted():
            raise KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            interrupted()

        assert [(s.name, s.status) for s in spans] == [("interrupted", "ERROR")]
        assert get_active_trace_context() is None


class TestSyncCallableReturningAwaitable:
    async def test_sync_function_returning_coroutine_span_covers_await(self, spans):
        body_ctx = []

        async def _inner():
            await asyncio.sleep(0.02)
            body_ctx.append(get_active_trace_context())
            return "ok"

        @trace()
        def handler():
            return _inner()

        coro = handler()
        assert len(spans) == 0
        res = await coro
        assert res == "ok"
        assert len(spans) == 1
        span = spans[0]
        assert span.status == "OK"
        assert span.duration_ms >= 15
        assert len(body_ctx) == 1
        assert body_ctx[0] is not None
        assert body_ctx[0].span_id == span.span_id
        assert get_active_trace_context() is None

    async def test_sync_function_returning_coroutine_records_error(self, spans):
        async def _inner():
            await asyncio.sleep(0)
            raise ValueError("boom")

        @trace()
        def handler():
            return _inner()

        with pytest.raises(ValueError, match="boom"):
            await handler()

        assert len(spans) == 1
        assert spans[0].status == "ERROR"
        assert spans[0].attributes["exception.type"] == "ValueError"

    async def test_sync_function_returning_async_generator_span_covers_iteration(self, spans):
        inside_ctx = []

        async def _agen():
            inside_ctx.append(get_active_trace_context())
            yield 1
            await asyncio.sleep(0.02)
            inside_ctx.append(get_active_trace_context())
            yield 2

        @trace()
        def handler():
            return _agen()

        it = handler()
        assert len(spans) == 0

        items = []
        async for x in it:
            items.append(x)
            assert get_active_trace_context() is None

        assert items == [1, 2]
        assert len(spans) == 1
        span = spans[0]
        assert span.status == "OK"
        assert span.duration_ms >= 15
        assert len(inside_ctx) == 2
        assert inside_ctx[0] is not None
        assert inside_ctx[0].span_id == span.span_id
        assert inside_ctx[1] is not None
        assert inside_ctx[1].span_id == span.span_id
        assert get_active_trace_context() is None

    async def test_sync_function_returning_async_generator_records_error(self, spans):
        async def _agen():
            yield 1
            raise ValueError("stream-fail")

        @trace()
        def handler():
            return _agen()

        items = []
        with pytest.raises(ValueError, match="stream-fail"):
            async for x in handler():
                items.append(x)

        assert items == [1]
        assert len(spans) == 1
        assert spans[0].status == "ERROR"
        assert spans[0].attributes["exception.type"] == "ValueError"

    async def test_callable_object_with_async_call(self, spans):
        class Handler:
            async def __call__(self, x):
                await asyncio.sleep(0.02)
                return x * 2

        traced_handler = trace()(Handler())
        assert await traced_handler(21) == 42
        assert len(spans) == 1
        span = spans[0]
        assert span.status == "OK"
        assert span.duration_ms >= 15
        assert span.name == "Handler"
        assert span.attributes["code.function"] == "Handler"

    async def test_child_of_outer_span_and_context_restored(self, spans):
        async def _inner():
            await asyncio.sleep(0.02)
            return "ok"

        @trace()
        def handler():
            return _inner()

        outer_ctx_after_await = None

        @trace()
        async def outer():
            nonlocal outer_ctx_after_await
            res = await handler()
            outer_ctx_after_await = get_active_trace_context()
            return res

        result = await outer()
        assert result == "ok"
        inner_span = spans[0]
        outer_span = spans[1]
        assert inner_span.attributes["code.function"] == "handler"
        assert outer_span.attributes["code.function"] == "outer"
        assert inner_span.parent_span_id == outer_span.span_id
        assert inner_span.trace_id == outer_span.trace_id
        assert outer_ctx_after_await is not None
        assert outer_ctx_after_await.span_id == outer_span.span_id
        assert get_active_trace_context() is None

    def test_plain_sync_function_unchanged(self, spans):
        body_ctx = []

        @trace()
        def plain():
            body_ctx.append(get_active_trace_context())
            return 5

        assert plain() == 5
        assert len(spans) == 1
        assert spans[0].status == "OK"
        assert len(body_ctx) == 1
        assert body_ctx[0] is not None
        assert body_ctx[0].span_id == spans[0].span_id
        assert get_active_trace_context() is None

        @trace()
        def plain_failing():
            raise RuntimeError("sync-boom")

        with pytest.raises(RuntimeError, match="sync-boom"):
            plain_failing()

        assert len(spans) == 2
        assert spans[1].status == "ERROR"
        assert spans[1].attributes["exception.type"] == "RuntimeError"
        assert get_active_trace_context() is None

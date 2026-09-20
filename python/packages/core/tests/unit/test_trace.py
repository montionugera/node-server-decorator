import json
import os
from pathlib import Path
import pytest

from server_decorator import (
    TraceContext,
    TraceSpan,
    format_traceparent,
    get_active_trace_context,
    parse_traceparent,
    set_active_trace_context,
    set_span_exporter,
    trace,
    traced,
    traced_class,
    emit_on_success,
    ConsumerRegistry,
    InMemoryConsumer,
    InMemoryQueueAdapter,
    global_queue_registry,
)


def load_fixtures():
    # Load contracts/fixtures/trace-context.cases.json
    root = Path(__file__).resolve().parents[5]
    fixtures_path = root / "contracts" / "fixtures" / "trace-context.cases.json"
    with open(fixtures_path, "r", encoding="utf-8") as f:
        return json.load(f)


class TestW3CCarrierParsingAndFormatting:
    def test_matches_contract_fixtures(self):
        cases = load_fixtures()
        for tc in cases:
            parsed = parse_traceparent(tc["traceparent"])
            if tc["valid"]:
                assert parsed is not None, f"Expected valid for {tc['traceparent']}"
                assert parsed.trace_id == tc["traceId"]
                assert parsed.span_id == tc["spanId"]
                assert parsed.sampled == tc["sampled"]
            else:
                assert parsed is None, f"Expected invalid for {tc['traceparent']}"

    def test_formats_valid_traceparent(self):
        formatted = format_traceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", True)
        assert formatted == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


class TestTraceDecorator:
    @pytest.fixture(autouse=True)
    def setup_spans(self):
        spans = []
        set_span_exporter(lambda s: spans.append(s))
        self.spans = spans
        yield
        set_span_exporter(None)

    @pytest.mark.asyncio
    async def test_async_traced_method(self):
        class UserService:
            @trace(name="users.get_by_id", attributes=lambda id_: {"user.id": id_})
            async def get_user(self, id_: str):
                ctx = get_active_trace_context()
                assert ctx is not None
                assert len(ctx.trace_id) == 32
                return {"id": id_, "name": "Alice"}

        svc = UserService()
        res = await svc.get_user("u-123")
        assert res == {"id": "u-123", "name": "Alice"}

        assert len(self.spans) == 1
        span = self.spans[0]
        assert span.name == "users.get_by_id"
        assert span.attributes["user.id"] == "u-123"
        assert span.status == "OK"
        assert span.duration_ms >= 0

    def test_sync_traced_method(self):
        class SyncService:
            @trace(name="sync.operation")
            def do_work(self, value: int):
                ctx = get_active_trace_context()
                assert ctx is not None
                return value * 2

        svc = SyncService()
        val = svc.do_work(21)
        assert val == 42

        assert len(self.spans) == 1
        assert self.spans[0].name == "sync.operation"
        assert self.spans[0].status == "OK"

    @pytest.mark.asyncio
    async def test_nested_spans_parent_propagation(self):
        class NestedService:
            @trace(name="parent.operation")
            async def parent(self):
                return await self.child()

            @trace(name="child.operation")
            async def child(self):
                ctx = get_active_trace_context()
                return ctx

        svc = NestedService()
        child_ctx = await svc.parent()

        assert len(self.spans) == 2
        child_span = next(s for s in self.spans if s.name == "child.operation")
        parent_span = next(s for s in self.spans if s.name == "parent.operation")

        assert child_span.trace_id == parent_span.trace_id
        assert child_span.parent_span_id == parent_span.span_id
        assert child_ctx.parent_span_id == parent_span.span_id

    @pytest.mark.asyncio
    async def test_error_recording_on_span(self):
        class ErrorService:
            @trace(name="failing.operation")
            async def fail(self):
                raise ValueError("database connection lost")

        svc = ErrorService()
        with pytest.raises(ValueError, match="database connection lost"):
            await svc.fail()

        assert len(self.spans) == 1
        span = self.spans[0]
        assert span.status == "ERROR"
        assert span.attributes["exception.type"] == "ValueError"
        assert span.attributes["exception.message"] == "database connection lost"
        assert "exception.stacktrace" in span.attributes

    @pytest.mark.asyncio
    async def test_traced_class_auto_wraps_methods(self):
        @traced_class()
        class AutoService:
            async def method_a(self):
                return "a"

            def method_b(self):
                return "b"

        svc = AutoService()
        await svc.method_a()
        svc.method_b()

        assert len(self.spans) == 2
        names = [s.name for s in self.spans]
        assert any("method_a" in n for n in names)
        assert any("method_b" in n for n in names)


class TestQueueTracePropagation:
    @pytest.fixture(autouse=True)
    def clean_registry(self):
        global_queue_registry.clear()
        spans = []
        set_span_exporter(lambda s: spans.append(s))
        self.spans = spans
        yield
        global_queue_registry.clear()
        set_span_exporter(None)

    @pytest.mark.asyncio
    async def test_injects_traceparent_into_queue_message_metadata(self):
        adapter = InMemoryQueueAdapter()
        global_queue_registry.register("orders", adapter)

        class OrderService:
            @trace(name="orders.create")
            @emit_on_success(
                queue="orders",
                topic="order.created",
                use_queue=True,
                use_events=False,
            )
            async def create_order(self, order_id: str):
                return {"id": order_id, "amount": 100}

        svc = OrderService()
        await svc.create_order("ord-123")

        messages = adapter.messages.get("order.created", [])
        assert len(messages) == 1
        msg = messages[0]
        assert "metadata" in msg
        assert "traceparent" in msg["metadata"]

        parsed = parse_traceparent(msg["metadata"]["traceparent"])
        assert parsed is not None
        assert parsed.trace_id == self.spans[0].trace_id

    @pytest.mark.asyncio
    async def test_consumer_registry_activates_trace_context(self):
        registry = ConsumerRegistry()
        consumed_trace_id = None
        consumed_parent_span_id = None

        def handler(payload, metadata):
            nonlocal consumed_trace_id, consumed_parent_span_id
            ctx = get_active_trace_context()
            if ctx:
                consumed_trace_id = ctx.trace_id
                consumed_parent_span_id = ctx.parent_span_id

        consumer = InMemoryConsumer([])
        registry.register("test_consumer", consumer)
        registry.on("order.created", handler, consumer="test_consumer")

        incoming_tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        dispatch = registry._dispatch_for("test_consumer")

        await dispatch({
            "eventName": "order.created",
            "payload": {"id": "ord-1"},
            "timestamp": 123456,
            "metadata": {
                "traceparent": incoming_tp,
            },
        })

        assert consumed_trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
        assert consumed_parent_span_id == "00f067aa0ba902b7"

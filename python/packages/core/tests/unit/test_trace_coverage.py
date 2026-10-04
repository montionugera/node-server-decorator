"""Coverage-gap tests for @trace: attribute resolution fallbacks, exporter failure
isolation, the no-exporter path, the `traced` alias and traceparent edge cases."""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from typing import Any

import pytest

from server_decorator.decorators.trace import (
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
)

# The package re-exports the `trace` function under the submodule's name, so the module
# object itself has to be fetched explicitly.
trace_mod = importlib.import_module("server_decorator.decorators.trace")


class _Log:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warn(self, msg: object) -> None:
        self.warnings.append(str(msg))

    def debug(self, msg: object) -> None: ...
    def info(self, msg: object) -> None: ...
    def error(self, msg: object) -> None: ...


@pytest.fixture
def spans() -> Iterator[list[TraceSpan]]:
    collected: list[TraceSpan] = []
    set_span_exporter(collected.append)
    yield collected
    set_span_exporter(None)


@pytest.fixture
def log(monkeypatch: pytest.MonkeyPatch) -> _Log:
    recorder = _Log()
    monkeypatch.setattr(trace_mod, "global_logger", recorder)
    return recorder


# ---------------------------------------------------------------- traceparent


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        123,
        "garbage",
        # wrong version
        "01-" + "a" * 32 + "-" + "b" * 16 + "-01",
        "ff-" + "a" * 32 + "-" + "b" * 16 + "-01",
        # all-zero ids
        "00-" + "0" * 32 + "-" + "b" * 16 + "-01",
        "00-" + "a" * 32 + "-" + "0" * 16 + "-01",
        # wrong lengths / uppercase hex / trailing segment
        "00-" + "a" * 31 + "-" + "b" * 16 + "-01",
        "00-" + "a" * 32 + "-" + "b" * 15 + "-01",
        "00-" + "A" * 32 + "-" + "b" * 16 + "-01",
        "00-" + "a" * 32 + "-" + "b" * 16 + "-01-extra",
    ],
)
def test_parse_traceparent_rejects_invalid(header: Any) -> None:
    assert parse_traceparent(header) is None


@pytest.mark.parametrize(
    ("flags", "sampled"), [("01", True), ("00", False), ("03", True), ("fe", False)]
)
def test_parse_traceparent_sampled_flag_is_bit_zero(flags: str, sampled: bool) -> None:
    ctx = parse_traceparent(f"  00-{'a' * 32}-{'b' * 16}-{flags}  ")
    assert ctx == TraceContext(trace_id="a" * 32, span_id="b" * 16, sampled=sampled)
    assert ctx is not None and ctx.parent_span_id is None and ctx.tracestate is None


def test_format_traceparent_round_trips() -> None:
    assert format_traceparent("a" * 32, "b" * 16) == f"00-{'a' * 32}-{'b' * 16}-01"
    unsampled = format_traceparent("a" * 32, "b" * 16, sampled=False)
    assert unsampled.endswith("-00")
    parsed = parse_traceparent(unsampled)
    assert parsed is not None and parsed.sampled is False


# ---------------------------------------------------------------- exporter handling


def test_without_exporter_the_function_still_runs_and_context_is_restored() -> None:
    set_span_exporter(None)
    seen: list[TraceContext | None] = []

    @trace()
    def work(x: int) -> int:
        seen.append(get_active_trace_context())
        return x * 2

    assert get_active_trace_context() is None
    assert work(21) == 42
    assert get_active_trace_context() is None
    [inner] = seen
    assert inner is not None
    assert len(inner.trace_id) == 32 and len(inner.span_id) == 16
    assert inner.parent_span_id is None and inner.sampled is True


def test_exporter_failure_is_logged_and_does_not_change_the_result(log: _Log) -> None:
    def broken(span: TraceSpan) -> None:
        raise RuntimeError("collector unreachable")

    set_span_exporter(broken)
    try:

        @trace()
        def work() -> str:
            return "ok"

        assert work() == "ok"
    finally:
        set_span_exporter(None)
    assert log.warnings == ["Trace span exporter error: collector unreachable"]


def test_exporter_failure_does_not_mask_the_original_error(log: _Log) -> None:
    def broken(span: TraceSpan) -> None:
        raise RuntimeError("collector unreachable")

    set_span_exporter(broken)
    try:

        @trace()
        def work() -> None:
            raise KeyError("original")

        with pytest.raises(KeyError, match="original"):
            work()
    finally:
        set_span_exporter(None)
    assert len(log.warnings) == 1
    assert get_active_trace_context() is None


def test_child_span_inherits_trace_sampling_and_tracestate(spans: list[TraceSpan]) -> None:
    parent = TraceContext(trace_id="c" * 32, span_id="d" * 16, sampled=False, tracestate="k=v")
    seen: list[TraceContext | None] = []

    @trace(name="child")
    def work() -> None:
        seen.append(get_active_trace_context())

    token = set_active_trace_context(parent)
    try:
        work()
        assert get_active_trace_context() is parent
    finally:
        trace_mod._ACTIVE_TRACE_CONTEXT.reset(token)

    [span] = spans
    assert (span.name, span.trace_id, span.parent_span_id) == ("child", "c" * 32, "d" * 16)
    assert span.sampled is False
    assert span.status == "OK"
    assert span.span_id != "d" * 16
    assert span.end_time_ms >= span.start_time_ms
    assert span.duration_ms >= 0
    [inner] = seen
    assert inner is not None and inner.tracestate == "k=v" and inner.span_id == span.span_id


# ---------------------------------------------------------------- attribute resolution


def test_static_attributes_merge_over_code_attributes(spans: list[TraceSpan]) -> None:
    @trace(attributes={"tier": "gold", "code.function": "overridden"})
    def work() -> None: ...

    work()
    [span] = spans
    assert span.attributes["tier"] == "gold"
    assert span.attributes["code.function"] == "overridden"
    assert span.attributes["code.namespace"].endswith("work")
    assert span.name.endswith("work")


def test_options_dict_form_supplies_name_and_attributes(spans: list[TraceSpan]) -> None:
    @trace({"name": "from-options", "attributes": {"a": 1}})
    def work() -> None: ...

    work()
    assert spans[0].name == "from-options"
    assert spans[0].attributes["a"] == 1


def test_keyword_arguments_win_over_options_dict(spans: list[TraceSpan]) -> None:
    @trace({"name": "from-options", "attributes": {"a": 1}}, name="kw", attributes={"b": 2})
    def work() -> None: ...

    work()
    assert spans[0].name == "kw"
    assert "a" not in spans[0].attributes
    assert spans[0].attributes["b"] == 2


def test_callable_attributes_receive_the_call_arguments(spans: list[TraceSpan]) -> None:
    @trace(attributes=lambda order_id, *, rush=False: {"order.id": order_id, "rush": rush})
    def ship(order_id: int, *, rush: bool = False) -> int:
        return order_id

    assert ship(7, rush=True) == 7
    assert spans[0].attributes["order.id"] == 7
    assert spans[0].attributes["rush"] is True


def test_callable_attributes_retry_without_self_on_methods(
    spans: list[TraceSpan], log: _Log
) -> None:
    class Svc:
        @trace(attributes=lambda order_id: {"order.id": order_id})
        def ship(self, order_id: int) -> int:
            return order_id + 1

    assert Svc().ship(7) == 8
    assert spans[0].attributes["order.id"] == 7
    assert log.warnings == []


def test_callable_attributes_non_dict_results_are_ignored(
    spans: list[TraceSpan], log: _Log
) -> None:
    @trace(attributes=lambda x: ["not", "a", "dict"])
    def free(x: int) -> int:
        return x

    class Svc:
        # First attempt (self, x) is a TypeError; the retry returns a non-dict.
        @trace(attributes=lambda x: "nope")
        def method(self, x: int) -> int:
            return x

    assert free(1) == 1
    assert Svc().method(2) == 2
    for span in spans:
        assert set(span.attributes) == {"code.function", "code.namespace"}
    assert log.warnings == []


def test_callable_attributes_retry_failure_is_logged_not_raised(
    spans: list[TraceSpan], log: _Log
) -> None:
    def attrs(x: int) -> dict[str, Any]:
        raise ValueError(f"cannot describe {x}")

    class Svc:
        @trace(attributes=attrs)
        def method(self, x: int) -> int:
            return x * 3

    assert Svc().method(2) == 6
    assert log.warnings == ["Failed to evaluate trace attributes: cannot describe 2"]
    assert spans[0].status == "OK"
    assert set(spans[0].attributes) == {"code.function", "code.namespace"}


def test_callable_attributes_type_error_with_no_arguments_is_logged(
    spans: list[TraceSpan], log: _Log
) -> None:
    @trace(attributes=lambda required: {"x": required})
    def work() -> str:
        return "done"

    assert work() == "done"
    assert log.warnings == ["Failed to evaluate trace attributes"]
    assert "x" not in spans[0].attributes


def test_callable_attributes_other_errors_are_logged(spans: list[TraceSpan], log: _Log) -> None:
    @trace(attributes=lambda payload: {"size": payload["missing"]})
    def work(payload: dict[str, Any]) -> int:
        return len(payload)

    assert work({}) == 0
    assert log.warnings == ["Failed to evaluate trace attributes: 'missing'"]
    assert spans[0].status == "OK"


# ---------------------------------------------------------------- aliases / class form


async def test_traced_alias_behaves_like_trace(spans: list[TraceSpan]) -> None:
    @traced({"attributes": {"a": 1}}, name="aliased")
    async def work(x: int) -> int:
        return x + 1

    assert await work(1) == 2
    assert getattr(work, "__wrapped__", None) is not None
    [span] = spans
    assert span.name == "aliased"
    assert span.attributes["a"] == 1
    assert span.status == "OK"


async def test_async_error_marks_span_error_and_restores_context(spans: list[TraceSpan]) -> None:
    @trace()
    async def work() -> None:
        raise LookupError("nope")

    with pytest.raises(LookupError):
        await work()
    [span] = spans
    assert span.status == "ERROR"
    assert span.attributes["exception.type"] == "LookupError"
    assert span.attributes["exception.message"] == "nope"
    assert "LookupError: nope" in span.attributes["exception.stacktrace"]
    assert get_active_trace_context() is None


def test_traced_class_include_exclude_and_private(spans: list[TraceSpan]) -> None:
    @traced_class(exclude=("skipped",), name="svc-span")
    class Svc:
        def kept(self) -> str:
            return "kept"

        def skipped(self) -> str:
            return "skipped"

        def _private(self) -> str:
            return "private"

    svc = Svc()
    assert (svc.kept(), svc.skipped(), svc._private()) == ("kept", "skipped", "private")
    assert [s.name for s in spans] == ["svc-span"]
    assert spans[0].attributes["code.function"] == "kept"

    spans.clear()

    @traced_class(include_private=True)
    class WithPrivate:
        def _private(self) -> int:
            return 1

    assert WithPrivate()._private() == 1
    assert len(spans) == 1
    assert spans[0].name.endswith("WithPrivate._private")

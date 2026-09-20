"""OpenTelemetry tracing decorator (@trace, @traced_class) and W3C context propagation."""

from __future__ import annotations

import contextvars
import functools
import inspect
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar, cast

from server_decorator.decorators._class_apply import _mark_wrapped, apply_to_class
from server_decorator.logger import global_logger

F = TypeVar("F", bound=Callable[..., Any])
T = TypeVar("T", bound=type)

_TRACEPARENT_REGEX = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")


@dataclass
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    sampled: bool = True
    tracestate: str | None = None


@dataclass
class TraceSpan:
    name: str
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    sampled: bool = True
    attributes: dict[str, Any] = field(default_factory=dict)
    start_time_ms: int = 0
    end_time_ms: int = 0
    duration_ms: float = 0.0
    status: str = "OK"  # "OK" | "ERROR"


_ACTIVE_TRACE_CONTEXT: contextvars.ContextVar[TraceContext | None] = contextvars.ContextVar(
    "active_trace_context", default=None
)

_SPAN_EXPORTER: Callable[[TraceSpan], None] | None = None


def set_span_exporter(exporter: Callable[[TraceSpan], None] | None) -> None:
    """Register or clear the span exporter callback."""
    global _SPAN_EXPORTER
    _SPAN_EXPORTER = exporter


def get_active_trace_context() -> TraceContext | None:
    """Return the currently active TraceContext in the async/thread execution context."""
    return _ACTIVE_TRACE_CONTEXT.get()


def set_active_trace_context(ctx: TraceContext | None) -> contextvars.Token[TraceContext | None]:
    """Set the active trace context and return token for reset."""
    return _ACTIVE_TRACE_CONTEXT.set(ctx)


def parse_traceparent(header: str | None) -> TraceContext | None:
    """Parse a W3C traceparent header string (00-traceid-spanid-flags)."""
    if not header or not isinstance(header, str):
        return None
    header = header.strip()
    match = _TRACEPARENT_REGEX.match(header)
    if not match:
        return None

    version, trace_id, span_id, flags = match.groups()

    # W3C spec: version 00 forbids all-zeros trace_id or span_id
    if version == "00":
        if trace_id == "0" * 32 or span_id == "0" * 16:
            return None

    # Version 'ff' is invalid in W3C
    if version == "ff":
        return None

    sampled = (int(flags, 16) & 0x01) == 1

    return TraceContext(
        trace_id=trace_id,
        span_id=span_id,
        sampled=sampled,
    )


def format_traceparent(trace_id: str, span_id: str, sampled: bool = True) -> str:
    """Format trace context into W3C traceparent header string."""
    flags = "01" if sampled else "00"
    return f"00-{trace_id}-{span_id}-{flags}"


def _generate_random_hex(byte_length: int) -> str:
    return os.urandom(byte_length).hex()


def trace(
    options: dict[str, Any] | None = None,
    *,
    name: str | None = None,
    attributes: dict[str, Any] | Callable[..., dict[str, Any]] | None = None,
) -> Callable[[F], F]:
    """Wrap a method or function to start an OpenTelemetry-compatible span."""
    opts = options or {}
    span_name = name or opts.get("name")
    attrs_config = attributes if attributes is not None else opts.get("attributes")

    def decorator(fn: F) -> F:
        qualname = getattr(fn, "__qualname__", fn.__name__)

        def _resolve_attributes(args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
            resolved = {
                "code.function": fn.__name__,
                "code.namespace": qualname,
            }
            if attrs_config:
                if callable(attrs_config):
                    try:
                        custom = attrs_config(*args, **kwargs)
                        if isinstance(custom, dict):
                            resolved.update(custom)
                    except TypeError:
                        # If args has self/cls as first parameter and callable fails, try with args[1:]
                        if len(args) > 0:
                            try:
                                custom = attrs_config(*args[1:], **kwargs)
                                if isinstance(custom, dict):
                                    resolved.update(custom)
                            except Exception as e2:
                                global_logger.warn(f"Failed to evaluate trace attributes: {e2}")
                        else:
                            global_logger.warn(f"Failed to evaluate trace attributes")
                    except Exception as e:
                        global_logger.warn(f"Failed to evaluate trace attributes: {e}")
                elif isinstance(attrs_config, dict):
                    resolved.update(attrs_config)
            return resolved

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                parent_ctx = get_active_trace_context()
                trace_id = parent_ctx.trace_id if parent_ctx else _generate_random_hex(16)
                parent_span_id = parent_ctx.span_id if parent_ctx else None
                span_id = _generate_random_hex(8)
                sampled = parent_ctx.sampled if parent_ctx else True

                current_ctx = TraceContext(
                    trace_id=trace_id,
                    span_id=span_id,
                    parent_span_id=parent_span_id,
                    sampled=sampled,
                    tracestate=parent_ctx.tracestate if parent_ctx else None,
                )

                resolved_name = span_name or qualname
                span_attrs = _resolve_attributes(args, kwargs)
                start_time_ms = int(time.time() * 1000)
                start_hr = time.perf_counter()

                token = _ACTIVE_TRACE_CONTEXT.set(current_ctx)
                status = "OK"
                try:
                    return await fn(*args, **kwargs)
                except Exception as err:
                    status = "ERROR"
                    span_attrs["exception.type"] = type(err).__name__
                    span_attrs["exception.message"] = str(err)
                    import traceback

                    span_attrs["exception.stacktrace"] = traceback.format_exc()
                    raise
                finally:
                    duration_ms = (time.perf_counter() - start_hr) * 1000
                    end_time_ms = int(time.time() * 1000)
                    _ACTIVE_TRACE_CONTEXT.reset(token)

                    if _SPAN_EXPORTER:
                        span = TraceSpan(
                            name=resolved_name,
                            trace_id=trace_id,
                            span_id=span_id,
                            parent_span_id=parent_span_id,
                            sampled=sampled,
                            attributes=span_attrs,
                            start_time_ms=start_time_ms,
                            end_time_ms=end_time_ms,
                            duration_ms=duration_ms,
                            status=status,
                        )
                        try:
                            _SPAN_EXPORTER(span)
                        except Exception as exp_err:
                            global_logger.warn(f"Trace span exporter error: {exp_err}")

            _mark_wrapped(async_wrapper, "trace")
            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            parent_ctx = get_active_trace_context()
            trace_id = parent_ctx.trace_id if parent_ctx else _generate_random_hex(16)
            parent_span_id = parent_ctx.span_id if parent_ctx else None
            span_id = _generate_random_hex(8)
            sampled = parent_ctx.sampled if parent_ctx else True

            current_ctx = TraceContext(
                trace_id=trace_id,
                span_id=span_id,
                parent_span_id=parent_span_id,
                sampled=sampled,
                tracestate=parent_ctx.tracestate if parent_ctx else None,
            )

            resolved_name = span_name or qualname
            span_attrs = _resolve_attributes(args, kwargs)
            start_time_ms = int(time.time() * 1000)
            start_hr = time.perf_counter()

            token = _ACTIVE_TRACE_CONTEXT.set(current_ctx)
            status = "OK"
            try:
                return fn(*args, **kwargs)
            except Exception as err:
                status = "ERROR"
                span_attrs["exception.type"] = type(err).__name__
                span_attrs["exception.message"] = str(err)
                import traceback

                span_attrs["exception.stacktrace"] = traceback.format_exc()
                raise
            finally:
                duration_ms = (time.perf_counter() - start_hr) * 1000
                end_time_ms = int(time.time() * 1000)
                _ACTIVE_TRACE_CONTEXT.reset(token)

                if _SPAN_EXPORTER:
                    span = TraceSpan(
                        name=resolved_name,
                        trace_id=trace_id,
                        span_id=span_id,
                        parent_span_id=parent_span_id,
                        sampled=sampled,
                        attributes=span_attrs,
                        start_time_ms=start_time_ms,
                        end_time_ms=end_time_ms,
                        duration_ms=duration_ms,
                        status=status,
                    )
                    try:
                        _SPAN_EXPORTER(span)
                    except Exception as exp_err:
                        global_logger.warn(f"Trace span exporter error: {exp_err}")

        _mark_wrapped(sync_wrapper, "trace")
        return cast(F, sync_wrapper)

    return decorator


def traced(
    options: dict[str, Any] | None = None,
    *,
    name: str | None = None,
    attributes: dict[str, Any] | Callable[..., dict[str, Any]] | None = None,
) -> Callable[[F], F]:
    """Alias for trace."""
    return trace(options, name=name, attributes=attributes)


def traced_class(
    options: dict[str, Any] | None = None,
    *,
    name: str | None = None,
    attributes: dict[str, Any] | Callable[..., dict[str, Any]] | None = None,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> Callable[[type[T]], type[T]]:
    """Class form: auto-wrap qualifying methods with @trace."""
    method_dec = trace(options, name=name, attributes=attributes)

    def decorator(cls: type[T]) -> type[T]:
        return apply_to_class(
            cls,
            method_dec,
            decorator_name="trace",
            include=include,
            exclude=exclude,
            include_private=include_private,
            wrap_properties=wrap_properties,
        )

    return decorator

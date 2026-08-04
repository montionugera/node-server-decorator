"""@on_event — register a function as a handler for an inbound event.

The decorated function is registered into a ConsumerRegistry (the global one by
default) keyed by event_name on the named consumer. It is returned unchanged, so it
remains directly callable/testable. Handlers receive (payload, metadata)."""

from __future__ import annotations

from collections.abc import Callable

from ..consumer.registry import ConsumerRegistry, Handler, global_consumer_registry


def on_event(
    event_name: str,
    *,
    consumer: str | None = None,
    registry: ConsumerRegistry | None = None,
) -> Callable[[Handler], Handler]:
    target = registry or global_consumer_registry

    def decorate(fn: Handler) -> Handler:
        target.on(event_name, fn, consumer=consumer)
        return fn

    return decorate

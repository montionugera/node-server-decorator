"""ConsumerAdapter protocol — the consume-side dual of QueueAdapter.

An adapter drains exactly one pipe at-least-once. It receives raw frames, hands each
decoded JSON value to ``dispatch``, and acks ONLY when dispatch returns without raising.
When dispatch raises, the adapter must NOT ack (backend-native redelivery)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

# dispatch(raw_json_value) -> awaitable; raising means "do not ack".
Dispatch = Callable[[Any], Awaitable[None]]


class ConsumerAdapter(Protocol):
    async def run(self, dispatch: Dispatch) -> None:
        """Begin consuming, calling dispatch per message, until stop() is called."""
        ...

    async def stop(self) -> None:
        """Stop consuming and release resources."""
        ...

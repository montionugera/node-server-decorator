"""QueueMessage TypedDict — the wire format. See contracts/schemas/queue-message.schema.json."""

from __future__ import annotations

from typing import Any, TypedDict


class QueueMessageMetadata(TypedDict, total=False):
    className: str
    methodName: str
    topic: str | None


class _QueueMessageRequired(TypedDict):
    eventName: str
    payload: Any
    timestamp: int


class QueueMessage(_QueueMessageRequired, total=False):
    metadata: QueueMessageMetadata

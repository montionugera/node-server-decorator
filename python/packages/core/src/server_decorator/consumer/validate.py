"""Validate an inbound wire envelope and split it into (eventName, payload, metadata).

Kept deliberately light: a structural check matching contracts/schemas/queue-message
(required eventName:str, payload present, timestamp:int). Full JSON-Schema validation is
done in parity/interop tests; the runtime path stays dependency-free."""

from __future__ import annotations

from typing import Any


class InvalidEnvelope(ValueError):  # noqa: N818
    """Raised when an inbound message does not match the QueueMessage contract."""


def validate_envelope(raw: Any) -> tuple[str, Any, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise InvalidEnvelope(f"envelope must be an object, got {type(raw).__name__}")
    event_name = raw.get("eventName")
    if not isinstance(event_name, str) or not event_name:
        raise InvalidEnvelope("envelope missing required non-empty string 'eventName'")
    if "payload" not in raw:
        raise InvalidEnvelope("envelope missing required 'payload'")
    timestamp = raw.get("timestamp")
    if not isinstance(timestamp, int) or isinstance(timestamp, bool):
        raise InvalidEnvelope("envelope missing required integer 'timestamp'")
    if "metadata" in raw and raw["metadata"] is not None:
        metadata = raw["metadata"]
        if not isinstance(metadata, dict):
            raise InvalidEnvelope("envelope 'metadata' must be an object when present")
    else:
        metadata = {}
    return event_name, raw["payload"], metadata

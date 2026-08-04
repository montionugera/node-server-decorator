"""Library-level configuration. Currently just the optional service name used to
prefix auto-topics and stamp ``metadata.service`` (contract 1.1.0)."""

from __future__ import annotations

import os

_service: str | None = os.environ.get("SERVER_DECORATOR_SERVICE") or None


def configure(*, service: str | None) -> None:
    """Set (or clear) the logical service name. Overrides SERVER_DECORATOR_SERVICE."""
    global _service
    _service = service or None


def get_service() -> str | None:
    """Return the configured service name, or None when unset."""
    return _service

"""Session-wide fixtures shared across all test packages."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

import server_decorator.config as _cfg


@pytest.fixture(autouse=True)
def _reset_service_config() -> Iterator[None]:
    _cfg.configure(service=None)
    yield
    _cfg.configure(service=None)

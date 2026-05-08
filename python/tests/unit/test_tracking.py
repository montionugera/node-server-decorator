"""Unit tests for @tracking and tracking_class."""

from __future__ import annotations

from typing import Any, List, Tuple

import pytest

from server_decorator import tracking, tracking_class
from server_decorator.tracker import set_global_tracker


class _RecordingTracker:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, int, bool]] = []

    def track(self, key: str, latency_ms: int, is_error: bool) -> None:
        self.calls.append((key, latency_ms, is_error))


@pytest.fixture
def rec() -> _RecordingTracker:
    r = _RecordingTracker()
    set_global_tracker(r)
    return r


def test_sync_method_success(rec: _RecordingTracker) -> None:
    class Svc:
        @tracking
        def go(self) -> int:
            return 7

    assert Svc().go() == 7
    assert len(rec.calls) == 1
    key, _, is_error = rec.calls[0]
    assert key == "Svc.go"
    assert is_error is False


def test_sync_method_error_reraises(rec: _RecordingTracker) -> None:
    class Svc:
        @tracking
        def go(self) -> int:
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        Svc().go()
    assert rec.calls[0][2] is True


async def test_async_method_success(rec: _RecordingTracker) -> None:
    class Svc:
        @tracking
        async def go(self) -> int:
            return 7

    assert await Svc().go() == 7
    assert rec.calls[0][0] == "Svc.go"
    assert rec.calls[0][2] is False


async def test_async_method_error_reraises(rec: _RecordingTracker) -> None:
    class Svc:
        @tracking
        async def go(self) -> int:
            raise ValueError("nope")

    with pytest.raises(ValueError, match="nope"):
        await Svc().go()
    assert rec.calls[0][2] is True


def test_class_form_wraps_public_methods(rec: _RecordingTracker) -> None:
    @tracking_class()
    class Svc:
        def public(self) -> int:
            return 1

        def _private(self) -> int:  # not wrapped (leading underscore)
            return 2

    s = Svc()
    s.public()
    s._private()
    assert [c[0] for c in rec.calls] == ["Svc.public"]


def test_class_form_classmethod_and_staticmethod(rec: _RecordingTracker) -> None:
    @tracking_class()
    class Svc:
        @classmethod
        def cls_method(cls) -> str:
            return "c"

        @staticmethod
        def static_method() -> str:
            return "s"

    assert Svc.cls_method() == "c"
    assert Svc.static_method() == "s"
    keys = [c[0] for c in rec.calls]
    assert "Svc.cls_method" in keys
    assert "Svc.static_method" in keys


def test_no_double_wrap_when_method_already_decorated(rec: _RecordingTracker) -> None:
    @tracking_class()
    class Svc:
        @tracking
        def go(self) -> int:
            return 1

    Svc().go()
    # Method-level wins; should fire exactly once.
    assert len(rec.calls) == 1


def test_class_form_include_excludes(rec: _RecordingTracker) -> None:
    @tracking_class(include=("__call__",), exclude=("ignore",))
    class Svc:
        def keep(self) -> Any:
            return 1

        def ignore(self) -> Any:
            return 2

        def __call__(self) -> Any:
            return 3

    s = Svc()
    s.keep()
    s.ignore()
    s()
    keys = [c[0] for c in rec.calls]
    assert "Svc.keep" in keys
    assert "Svc.__call__" in keys
    assert all("ignore" not in k for k in keys)


def test_class_form_does_not_walk_mro(rec: _RecordingTracker) -> None:
    """N2: subclass inherits a base method without re-wrapping it."""

    @tracking_class()
    class Base:
        def method(self) -> int:
            return 1

    @tracking_class()
    class Sub(Base):
        # No override — inherited method is NOT re-wrapped from Base.
        pass

    Sub().method()
    # Wrapped once by Base's class-decoration; Sub's pass is a no-op for the inherited.
    assert len(rec.calls) == 1
    assert rec.calls[0][0] == "Base.method"

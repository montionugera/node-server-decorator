"""Unit tests for shorten_qualname."""

from __future__ import annotations

import pytest

from server_decorator.decorators._qualname import shorten_qualname


@pytest.mark.parametrize(
    ("qualname", "expected"),
    [
        ("Svc.go", "Svc.go"),
        ("test_x.<locals>.Svc.go", "Svc.go"),
        ("Outer.Inner.go", "Inner.go"),
        ("a.<locals>.b.<locals>.Svc.go", "Svc.go"),
        # Fewer than two real segments: returned unchanged.
        ("go", "go"),
        ("", ""),
    ],
)
def test_shorten_qualname(qualname: str, expected: str) -> None:
    assert shorten_qualname(qualname) == expected


def test_single_segment_keeps_locals_marker_untouched() -> None:
    # Only one non-<locals> segment remains, so the fallback returns the input verbatim
    # rather than the filtered segment.
    assert shorten_qualname("<locals>.go") == "<locals>.go"


def test_real_nested_function_and_method() -> None:
    def free() -> None: ...

    class Svc:
        def go(self) -> None: ...

    assert shorten_qualname(Svc.go.__qualname__) == "Svc.go"
    assert shorten_qualname(free.__qualname__) == "test_real_nested_function_and_method.free"

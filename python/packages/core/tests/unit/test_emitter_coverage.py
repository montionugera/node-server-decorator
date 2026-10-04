"""Unit coverage for the in-process emitter (on / off / emit edge cases)."""

from __future__ import annotations

from typing import Any

import pytest

from server_decorator.emitter import _Emitter, global_emitter


def test_emit_passes_args_and_kwargs_to_listeners_in_registration_order() -> None:
    em = _Emitter()
    calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
    em.on("e", lambda *a, **k: calls.append(("first", a, k)))
    em.on("e", lambda *a, **k: calls.append(("second", a, k)))

    em.emit("e", 1, "two", flag=True)

    assert calls == [("first", (1, "two"), {"flag": True}), ("second", (1, "two"), {"flag": True})]


def test_emit_with_no_listeners_is_a_noop() -> None:
    em = _Emitter()

    assert em.emit("nobody-listens", 1) is None
    assert em._listeners == {}  # emit must not create empty listener buckets


def test_emit_only_reaches_listeners_of_that_event() -> None:
    em = _Emitter()
    got: list[str] = []
    em.on("a", lambda: got.append("a"))
    em.on("b", lambda: got.append("b"))

    em.emit("a")

    assert got == ["a"]


def test_off_removes_listener() -> None:
    em = _Emitter()
    got: list[int] = []

    def listener(n: int) -> None:
        got.append(n)

    em.on("e", listener)
    em.emit("e", 1)
    em.off("e", listener)
    em.emit("e", 2)

    assert got == [1]


def test_off_removes_only_one_registration_of_a_duplicate_listener() -> None:
    em = _Emitter()
    got: list[int] = []

    def listener() -> None:
        got.append(1)

    em.on("e", listener)
    em.on("e", listener)
    em.off("e", listener)
    em.emit("e")

    assert got == [1]


def test_off_unknown_event_is_a_noop() -> None:
    em = _Emitter()

    em.off("never-registered", lambda: None)

    assert em._listeners == {}


def test_off_unregistered_listener_is_a_noop_and_keeps_others() -> None:
    em = _Emitter()
    got: list[str] = []

    def kept() -> None:
        got.append("kept")

    em.on("e", kept)
    em.off("e", lambda: None)  # not registered: ValueError is swallowed
    em.emit("e")

    assert got == ["kept"]


def test_listener_removing_itself_during_emit_does_not_skip_the_next_listener() -> None:
    em = _Emitter()
    got: list[str] = []

    def once() -> None:
        got.append("once")
        em.off("e", once)

    em.on("e", once)
    em.on("e", lambda: got.append("second"))

    em.emit("e")
    em.emit("e")

    assert got == ["once", "second", "second"]


def test_listener_exception_propagates_and_stops_later_listeners() -> None:
    em = _Emitter()
    got: list[str] = []

    def boom() -> None:
        raise RuntimeError("listener boom")

    em.on("e", boom)
    em.on("e", lambda: got.append("after"))

    with pytest.raises(RuntimeError, match="listener boom"):
        em.emit("e")

    assert got == []


def test_global_emitter_is_a_shared_emitter_instance() -> None:
    got: list[int] = []

    def listener(n: int) -> None:
        got.append(n)

    assert isinstance(global_emitter, _Emitter)
    global_emitter.on("test_emitter_coverage.event", listener)
    try:
        global_emitter.emit("test_emitter_coverage.event", 42)
    finally:
        global_emitter.off("test_emitter_coverage.event", listener)
    global_emitter.emit("test_emitter_coverage.event", 43)

    assert got == [42]

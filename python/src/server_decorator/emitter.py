"""In-process event emitter. Mirrors Node's `globalEmitter` (eventemitter3)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

_Listener = Callable[..., Any]


class _Emitter:
    def __init__(self) -> None:
        self._listeners: dict[str, list[_Listener]] = {}

    def on(self, event: str, listener: _Listener) -> None:
        self._listeners.setdefault(event, []).append(listener)

    def off(self, event: str, listener: _Listener) -> None:
        if event in self._listeners:
            try:
                self._listeners[event].remove(listener)
            except ValueError:
                pass

    def emit(self, event: str, *args: Any, **kwargs: Any) -> None:
        for listener in list(self._listeners.get(event, [])):
            listener(*args, **kwargs)


global_emitter: _Emitter = _Emitter()

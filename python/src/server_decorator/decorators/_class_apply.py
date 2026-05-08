"""Class-decorator helper: walk vars(cls), apply a method-decorator to each qualifying member.

Decision #4. The marker `__server_decorator_wrapped_by__` prevents double-wrapping when
both class-level and method-level decoration apply (method-level wins).
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

_MARKER = "__server_decorator_wrapped_by__"


def _is_wrapped_by(fn: Callable[..., Any], name: str) -> bool:
    return name in getattr(fn, _MARKER, ())


def _mark_wrapped(wrapper: Callable[..., Any], name: str) -> None:
    existing: tuple[str, ...] = getattr(wrapper, _MARKER, ())
    object.__setattr__(wrapper, _MARKER, (*existing, name))


def apply_to_class(
    cls: type,
    method_decorator: Callable[[Callable[..., Any]], Callable[..., Any]],
    *,
    decorator_name: str,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    include_private: bool = False,
    wrap_properties: bool = False,
) -> type:
    for attr_name, attr in list(vars(cls).items()):
        if attr_name in exclude:
            continue
        if attr_name.startswith("_") and attr_name not in include and not include_private:
            continue

        if isinstance(attr, classmethod):
            inner = attr.__func__
            if _is_wrapped_by(inner, decorator_name):
                continue
            wrapped = method_decorator(inner)
            _mark_wrapped(wrapped, decorator_name)
            setattr(cls, attr_name, classmethod(wrapped))
        elif isinstance(attr, staticmethod):
            inner = attr.__func__
            if _is_wrapped_by(inner, decorator_name):
                continue
            wrapped = method_decorator(inner)
            _mark_wrapped(wrapped, decorator_name)
            setattr(cls, attr_name, staticmethod(wrapped))
        elif isinstance(attr, property):
            if not wrap_properties:
                continue
            # v1.1+: wrap fget/fset; deferred per N1.
            continue
        elif inspect.isfunction(attr) or inspect.iscoroutinefunction(attr):
            if _is_wrapped_by(attr, decorator_name):
                continue
            wrapped = method_decorator(attr)
            _mark_wrapped(wrapped, decorator_name)
            setattr(cls, attr_name, wrapped)
        # else: nested classes, plain attrs — ignored.
    return cls

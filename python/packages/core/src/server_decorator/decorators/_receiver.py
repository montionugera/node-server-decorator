"""Receiver (`self`/`cls`) detection shared by `@cache` and `@batch_load`.

A decorator only sees a plain function, so it has to tell `obj.method(key)` (first argument
is the receiver) from `function(key)` (first argument is data). The rule, in order:

1. A first parameter named `self`/`cls` is the receiver when the function is defined in a
   class body or another positional parameter follows it ("always").
2. Any other function defined in a class body is resolved per call ("ambiguous"): the first
   argument is the receiver when its class - or, for a class argument, the class itself -
   owns the decorated function. A `staticmethod` never has a receiver.
3. Everything else has no receiver ("never"), including a plain function whose only
   parameter happens to be named `self`.
"""

from __future__ import annotations

import inspect
import weakref
from collections.abc import Callable
from typing import Any, Literal

ReceiverMode = Literal["always", "ambiguous", "never"]


def receiver_mode(fn: Callable[..., Any], *, key_required: bool) -> tuple[ReceiverMode, list[str]]:
    """Classify `fn` once, at decoration time; also returns its positional parameter names.

    `key_required` is for decorators whose call must carry a key after the receiver
    (`@batch_load`): a lone parameter is then the key, and `*args` is not a receiver slot.
    """
    try:
        params = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return "never", []
    pos_params = [
        p.name
        for p in params
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    slots = len(pos_params)
    if not key_required and any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in params):
        slots += 1
    qualname_parts = getattr(fn, "__qualname__", "").split(".")
    in_class_body = len(qualname_parts) >= 2 and qualname_parts[-2] != "<locals>"

    if pos_params and pos_params[0] in ("self", "cls") and (slots >= 2 or in_class_body):
        return "always", pos_params
    if in_class_body and slots >= (2 if key_required else 1):
        return "ambiguous", pos_params
    return "never", pos_params


def _unwraps_to(val: Any, target: Any) -> bool:
    cur = val
    for _ in range(10):
        if cur is target:
            return True
        try:
            # Foreign class attribute raising non-AttributeError must not break.
            if hasattr(cur, "__func__"):
                cur = cur.__func__
            elif hasattr(cur, "__wrapped__"):
                cur = cur.__wrapped__
            else:
                break
        except Exception:
            break
    return cur is target


def _first_arg_owns(
    first_arg: Any, wrapper: Any, owner_cache: weakref.WeakKeyDictionary[type, bool]
) -> bool:
    target_type: type = first_arg if isinstance(first_arg, type) else type(first_arg)
    cached = owner_cache.get(target_type)
    if cached is not None:
        return cached
    mros: list[type] = []
    if isinstance(first_arg, type):
        mros.extend(getattr(first_arg, "__mro__", ()))
    mros.extend(getattr(type(first_arg), "__mro__", ()))
    seen_classes: set[type] = set()
    for cls_obj in mros:
        if cls_obj in seen_classes:
            continue
        seen_classes.add(cls_obj)
        for val in vars(cls_obj).values():
            if isinstance(val, staticmethod):
                continue
            if _unwraps_to(val, wrapper):
                owner_cache[target_type] = True
                return True
    owner_cache[target_type] = False
    return False


def has_receiver(
    mode: ReceiverMode,
    args: tuple[Any, ...],
    wrapper: Any,
    owner_cache: weakref.WeakKeyDictionary[type, bool],
) -> bool:
    """Per call: is `args[0]` the receiver? `wrapper` is the decorated function as stored on
    the class; `owner_cache` is that decorator's per-type memo of the ownership answer."""
    if mode == "always":
        return True
    if mode == "never" or not args:
        return False
    return _first_arg_owns(args[0], wrapper, owner_cache)

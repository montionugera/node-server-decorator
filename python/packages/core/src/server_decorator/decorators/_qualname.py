"""Qualname normaliser. Drops `<locals>` markers and keeps the last two segments
so test-defined classes / nested classes match Node's `ClassName.methodName`."""

from __future__ import annotations


def shorten_qualname(qualname: str) -> str:
    parts = [p for p in qualname.split(".") if p != "<locals>"]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return qualname

"""Field markers used inside Annotated[...] on @restful classes."""

from dataclasses import dataclass
from typing import Any

from server_decorator_entity.validate import (
    assert_enum_nonempty,
    assert_format_pattern_exclusive,
    assert_integer_or_none,
    assert_portable_pattern,
    assert_wire_name_not_reserved,
)


@dataclass(frozen=True)
class FieldMarker:
    type: str
    role: str | None = None
    format: str | None = None
    enum: tuple[str, ...] | None = None
    min: int | None = None
    max: int | None = None
    pattern: str | None = None
    optional: bool = False
    nullable: bool = False
    readonly: bool = False
    writeonly: bool = False
    filterable: bool = False
    item: "FieldMarker | None" = None
    ref: str | None = None
    fields: tuple[tuple[str, "FieldMarker"], ...] | None = None  # (name, marker) pairs for obj

    def to_ir(self, name: str) -> dict[str, Any]:
        label = f'field "{name}"'
        assert_wire_name_not_reserved(name, label)
        assert_format_pattern_exclusive(self.format, self.pattern, label)
        assert_portable_pattern(self.pattern, label)
        assert_enum_nonempty(self.enum, label)
        assert_integer_or_none(self.min, f"{label}.min")
        assert_integer_or_none(self.max, f"{label}.max")

        ir: dict[str, Any] = {"name": name, "type": self.type}
        if self.role:
            ir["role"] = self.role
        if self.format:
            ir["format"] = self.format
        if self.enum:
            ir["enum"] = list(self.enum)
        if self.min is not None:
            ir["min"] = self.min
        if self.max is not None:
            ir["max"] = self.max
        if self.pattern:
            ir["pattern"] = self.pattern
        for flag in ("optional", "nullable", "readonly", "writeonly", "filterable"):
            if getattr(self, flag):
                ir[flag] = True
        if self.item:
            ir["item"] = self.item.to_ir(name)
        if self.ref:
            ir["ref"] = self.ref
        if self.fields is not None:
            ir["fields"] = [m.to_ir(n) for n, m in self.fields]
        return ir


def Id() -> FieldMarker:  # noqa: N802
    return FieldMarker(type="str", role="id", readonly=True)


def Str(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="str", **kw)


def Email(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="str", format="email", **kw)


def Uuid(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="str", format="uuid", **kw)


def Uri(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="str", format="uri", **kw)


def Int(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="int", **kw)


def Float(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="float", **kw)


def Bool(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="bool", **kw)


def Datetime(**kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="datetime", **kw)


def EnumOf(*values: str, **kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="enum", enum=values, **kw)


def Ref(entity: str, **kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="ref", ref=entity, **kw)


def ListOf(item: FieldMarker, **kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="list", item=item, **kw)


def Obj(fields: list[tuple[str, FieldMarker]], **kw: Any) -> FieldMarker:  # noqa: N802
    return FieldMarker(type="obj", fields=tuple(fields), **kw)

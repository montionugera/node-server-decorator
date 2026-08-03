"""Compile EntitySpec IR dicts into pydantic v2 models (create/update/read/action DTOs)."""

from collections.abc import Callable
from typing import Any, Literal

import pydantic
from pydantic import ConfigDict, Field, create_model

_CONFIG = ConfigDict(extra="forbid")

Include = Callable[[dict[str, Any]], bool]


def _annotation(f: dict[str, Any], include: Include) -> tuple[Any, Any]:
    """Return (type annotation, FieldInfo) for one IR field."""
    t = f["type"]
    ann: Any
    kwargs: dict[str, Any] = {}
    if t == "str" or t == "ref":
        ann = str
        if f.get("format") == "email":
            ann = pydantic.EmailStr
        if "min" in f:
            kwargs["min_length"] = f["min"]
        if "max" in f:
            kwargs["max_length"] = f["max"]
        if "pattern" in f:
            kwargs["pattern"] = f["pattern"]
        if f.get("format") == "uuid":
            kwargs["pattern"] = r"^[0-9a-fA-F-]{36}$"
    elif t == "int":
        ann = int
        if "min" in f:
            kwargs["ge"] = f["min"]
        if "max" in f:
            kwargs["le"] = f["max"]
    elif t == "float":
        ann = float
        if "min" in f:
            kwargs["ge"] = f["min"]
        if "max" in f:
            kwargs["le"] = f["max"]
    elif t == "bool":
        ann = bool
    elif t == "datetime":
        # IR 'datetime' requires an explicit UTC offset on the wire (multi-replica
        # decision) — a naive ISO-8601 string (no offset) must be rejected, so this
        # is AwareDatetime only, never `AwareDatetime | NaiveDatetime`.
        ann = pydantic.AwareDatetime
    elif t == "enum":
        ann = Literal[tuple(f["enum"])]
    elif t == "list":
        inner_ann, _ = _annotation(f["item"], include)
        ann = list[inner_ann]  # type: ignore[valid-type]
    elif t == "obj":
        # Thread the caller's DTO include predicate into the nested model so a
        # readonly/writeonly nested field is excluded from the DTOs that shouldn't
        # see it (gen-zod parity) — never `lambda _f: True`.
        ann = _model("Obj", f.get("fields", []), include)
    else:
        raise ValueError(f"unknown field type {t}")

    nullable = bool(f.get("nullable"))
    optional = bool(f.get("optional"))
    if nullable:
        ann = ann | None

    # Optional/nullable semantics must match gen-zod: `optional` only controls
    # whether the key may be absent from the payload (falls back to a default);
    # it must NOT by itself widen the annotation to accept an explicitly-provided
    # `null` — only `nullable` does that. pydantic validates explicitly-provided
    # values against `ann` regardless of the default, and does not validate the
    # default itself (validate_default is off by default), so:
    #   - optional + nullable:      ann | None, default None   -> absent OK, null OK
    #   - optional + not nullable:  ann,        default None   -> absent OK, null REJECTED
    #   - required (not optional):  ann,        default ...    -> key must be present
    default: Any = None if optional else ...
    return (ann, Field(default, **kwargs))


def _model(name: str, fields: list[dict[str, Any]], include: Include) -> type[pydantic.BaseModel]:
    defs: dict[str, Any] = {}
    for f in fields:
        if include(f):
            defs[f["name"]] = _annotation(f, include)
    return create_model(name, __config__=_CONFIG, **defs)


def _not_readonly(f: dict[str, Any]) -> bool:
    return not f.get("readonly")


def _not_writeonly(f: dict[str, Any]) -> bool:
    return not f.get("writeonly")


def _include_all(_f: dict[str, Any]) -> bool:
    return True


def create_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    return _model(f"{spec['entity']}Create", spec["fields"], _not_readonly)


def update_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    # Parity with gen-zod's `updateSchema = createSchema(spec).partial()`: only the
    # TOP-LEVEL fields become optional (a partial update). Nested obj/list fields keep
    # their own declared optional/nullable flags and are still filtered by the same
    # `not readonly` predicate used for create — never `lambda f: True`, or a readonly
    # nested field would leak back in on update.
    base = spec["fields"]
    optional = [dict(f, optional=True) for f in base if not f.get("readonly")]
    return _model(f"{spec['entity']}Update", optional, _not_readonly)


def read_model_for(spec: dict[str, Any]) -> type[pydantic.BaseModel]:
    return _model(f"{spec['entity']}Read", spec["fields"], _not_writeonly)


def action_input_model_for(spec: dict[str, Any], action_name: str) -> type[pydantic.BaseModel]:
    act = next((a for a in spec.get("actions", []) if a["name"] == action_name), None)
    if act is None:
        raise ValueError(f"Unknown action {action_name!r} on entity {spec['entity']}")
    return _model(
        f"{spec['entity']}Action{action_name.capitalize()}", act.get("input", []), _include_all
    )


def validation_error_fields(exc: pydantic.ValidationError) -> list[str]:
    fields: set[str] = set()
    for err in exc.errors():
        loc = [str(p) for p in err["loc"]]
        fields.add(".".join(loc))
    return sorted(fields)


__all__ = [
    "action_input_model_for",
    "create_model_for",
    "read_model_for",
    "update_model_for",
    "validation_error_fields",
]

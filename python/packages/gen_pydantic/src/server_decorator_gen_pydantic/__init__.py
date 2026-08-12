"""Compile EntitySpec IR dicts into pydantic v2 models (create/update/read/action DTOs)."""

from collections.abc import Callable
from typing import Annotated, Any, Literal

import pydantic
from pydantic import BeforeValidator, ConfigDict, Field, create_model
from pydantic_core import SchemaError

_CONFIG = ConfigDict(extra="forbid")

# WHATWG HTML5 email pattern — see contracts/rules/entity-spec-validation.md. Both gen-zod and
# gen-pydantic MUST validate `format: "email"` against this exact regex (not either ecosystem's
# built-in email validator, which diverge from each other: pydantic's `EmailStr` accepts
# `a@b.c`, zod's `.email()` rejects it). A raw string, so no Python string-literal backslash
# processing touches the pattern before it reaches `re`.
EMAIL_PATTERN = (
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9]"
    r"(?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)

# Shared uuid/uri regexes — see contracts/rules/entity-spec-validation.md. Both gen-zod and
# gen-pydantic MUST validate `format: "uuid"`/`format: "uri"` against these exact patterns, not
# either ecosystem's built-in (`zod.uuid()`/`.url()`, pydantic's `AnyUrl`), which diverge from
# each other and from these.
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
URI_PATTERN = r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+$"

Include = Callable[[dict[str, Any]], bool]


def _reject_str(v: Any) -> Any:
    """BeforeValidator for int/float/bool fields — see 'JSON-type strictness' in
    contracts/rules/entity-spec-validation.md. All payloads arrive as parsed JSON, so JSON's
    (not Python's) type system is the arbiter: a JSON string ("5", "true") must not coerce into
    a number/boolean field, matching zod's no-coercion behavior. This intentionally does NOT use
    a blanket `strict=True` model config — that would also break legitimate ISO-string ->
    AwareDatetime parsing on datetime fields. Non-string values pass through unchanged, so
    pydantic's normal lax integral-float -> int coercion (5.0 -> 5 ok, 5.5 -> rejected) still
    applies for `int` fields.
    """
    if isinstance(v, str):
        raise ValueError("string input is not accepted for this field's type")
    return v


def _reject_non_str_datetime(v: Any) -> Any:
    """BeforeValidator for datetime fields — rejects a non-string JSON value (e.g. an integer
    epoch timestamp) ahead of AwareDatetime parsing. An epoch integer is neither ISO 8601 nor
    string-shaped and must not be silently accepted, per entity-spec-validation.md.
    """
    if not isinstance(v, str):
        raise ValueError("datetime fields require an ISO-8601 string with a UTC offset")
    return v


def _annotation(f: dict[str, Any], include: Include) -> tuple[Any, Any]:
    """Return (type annotation, FieldInfo) for one IR field."""
    t = f["type"]
    ann: Any
    kwargs: dict[str, Any] = {}
    if t == "str" or t == "ref":
        # `ref` is a string (an entity id) carrying the same constraints a `str` field would —
        # see contracts/rules/entity-spec-validation.md "ref — string with the same constraints
        # as str" (I-c; parity with gen-zod's `case 'ref': case 'str':` fallthrough).
        ann = str
        fmt = f.get("format")
        # Decoration-time validation (both entity packages) already rejects format+pattern
        # co-occurring on one field, so at most one of these branches ever sets kwargs["pattern"].
        if fmt == "email":
            kwargs["pattern"] = EMAIL_PATTERN
        elif fmt == "uuid":
            kwargs["pattern"] = UUID_PATTERN
        elif fmt == "uri":
            kwargs["pattern"] = URI_PATTERN
        elif "pattern" in f:
            kwargs["pattern"] = f["pattern"]
        if "min" in f:
            kwargs["min_length"] = f["min"]
        if "max" in f:
            kwargs["max_length"] = f["max"]
    elif t == "int":
        ann = Annotated[int, BeforeValidator(_reject_str)]
        if "min" in f:
            kwargs["ge"] = f["min"]
        if "max" in f:
            kwargs["le"] = f["max"]
    elif t == "float":
        ann = Annotated[float, BeforeValidator(_reject_str)]
        if "min" in f:
            kwargs["ge"] = f["min"]
        if "max" in f:
            kwargs["le"] = f["max"]
    elif t == "bool":
        ann = Annotated[bool, BeforeValidator(_reject_str)]
    elif t == "datetime":
        # IR 'datetime' requires an explicit UTC offset on the wire (multi-replica
        # decision) — a naive ISO-8601 string (no offset) must be rejected, so this
        # is AwareDatetime only, never `AwareDatetime | NaiveDatetime`. The BeforeValidator
        # additionally rejects a non-string JSON value (e.g. an epoch int) ahead of that parse.
        ann = Annotated[pydantic.AwareDatetime, BeforeValidator(_reject_non_str_datetime)]
    elif t == "enum":
        ann = Literal[tuple(f["enum"])]
    elif t == "list":
        # Thread the item's own (annotation, FieldInfo) pair through Annotated so item-level
        # constraints (min/max/pattern/format) are enforced on every element, not silently
        # dropped (C2) — never `list[inner_ann]` alone.
        inner_ann, inner_fi = _annotation(f["item"], include)
        ann = list[Annotated[inner_ann, inner_fi]]  # type: ignore[valid-type]
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
    pattern_fields: list[tuple[str, str]] = []
    for f in fields:
        if not include(f):
            continue
        defs[f["name"]] = _annotation(f, include)
        pattern = f.get("pattern") or (
            EMAIL_PATTERN
            if f.get("format") == "email"
            else UUID_PATTERN
            if f.get("format") == "uuid"
            else URI_PATTERN
            if f.get("format") == "uri"
            else None
        )
        if pattern is not None:
            pattern_fields.append((f["name"], pattern))
    try:
        return create_model(name, __config__=_CONFIG, **defs)
    except SchemaError as exc:
        # Two classes of schema-valid IR abort model-build entirely (I-b(2)): a `pattern` using
        # a regex feature (lookaround, backreferences) pydantic's Rust-backed engine doesn't
        # support. Reserved-wire-name collisions are now rejected earlier, at decoration time in
        # both entity packages, so this branch is effectively regex-flavor-only in practice —
        # but the wrap stays generic so any future create_model() failure gets a message naming
        # the candidate field(s)/pattern(s) instead of pydantic's own less-specific SchemaError.
        detail = (
            "; ".join(f"field {n!r} pattern {p!r}" for n, p in pattern_fields)
            if pattern_fields
            else "no field on this model declares a pattern/format"
        )
        raise ValueError(
            f"Failed to build pydantic model {name!r}: {exc}. Candidate field(s): {detail}. "
            "If this involves `pattern`, it must be RE2/rust-regex compatible (no lookaround, "
            "no backreferences) — see contracts/rules/entity-spec-validation.md."
        ) from exc


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
    "EMAIL_PATTERN",
    "URI_PATTERN",
    "UUID_PATTERN",
    "action_input_model_for",
    "create_model_for",
    "read_model_for",
    "update_model_for",
    "validation_error_fields",
]

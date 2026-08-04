"""Decoration-time IR validation shared across field markers and @restful.

Mirrors node/packages/entity/src/validate.ts — see contracts/rules/entity-spec-validation.md
for the shared invariants (reserved wire names, format+pattern exclusivity, integer min/max,
non-empty enum/ops/transports) both language packages enforce identically.
"""

from typing import Any

# Public pydantic.BaseModel attribute names (pydantic v2). A wire name colliding with one of
# these makes gen-pydantic's create_model() raise "shadows an attribute in parent BaseModel" —
# reject at decoration time in BOTH languages instead of letting it crash gen-pydantic's model
# build. See contracts/rules/entity-spec-validation.md "Reserved wire names".
RESERVED_WIRE_NAMES: frozenset[str] = frozenset(
    {
        "construct",
        "copy",
        "dict",
        "from_orm",
        "json",
        "model_computed_fields",
        "model_config",
        "model_construct",
        "model_copy",
        "model_dump",
        "model_dump_json",
        "model_extra",
        "model_fields",
        "model_fields_set",
        "model_json_schema",
        "model_parametrized_name",
        "model_post_init",
        "model_rebuild",
        "model_validate",
        "model_validate_json",
        "model_validate_strings",
        "parse_file",
        "parse_obj",
        "parse_raw",
        "schema",
        "schema_json",
        "update_forward_refs",
        "validate",
    }
)


def assert_integer_or_none(value: Any, label: str) -> None:
    if value is None:
        return
    # bool is a subclass of int in Python — isinstance(True, int) is True — so it must be
    # excluded explicitly, not just checked for isinstance(value, int).
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{label}: min/max must be integers (got {value!r})")


def assert_wire_name_not_reserved(name: str, label: str) -> None:
    if name in RESERVED_WIRE_NAMES:
        raise ValueError(
            f"{label}: wire name {name!r} is reserved (shadows a pydantic BaseModel attribute)"
        )


def assert_format_pattern_exclusive(fmt: Any, pattern: Any, label: str) -> None:
    if fmt is not None and pattern is not None:
        raise ValueError(f"{label}: format and pattern are mutually exclusive")


def assert_enum_nonempty(enum: Any, label: str) -> None:
    if enum is not None and len(enum) == 0:
        raise ValueError(f"{label}: enum must have at least one value")


_LOOKAROUND_MARKERS = ("(?=", "(?!", "(?<=", "(?<!")


def _has_backreference(pattern: str) -> bool:
    """A `\\` run of odd length immediately before a digit 1-9 means that digit is escaped — a
    backreference (`\\1`). An even-length run means the backslashes are themselves escaped
    (`\\\\1` is a literal backslash followed by the literal digit `1`), so it's NOT a
    backreference. `\\0` is never a backreference (it's either a literal `0` or, in some engines,
    a null escape — not a capture-group reference), so only digits 1-9 are scanned. This is a
    conservative lexical scan, not a regex parser — see
    contracts/rules/entity-spec-validation.md for what it does and does not catch.
    """
    for i, c in enumerate(pattern):
        if c in "123456789":
            backslashes = 0
            j = i - 1
            while j >= 0 and pattern[j] == "\\":
                backslashes += 1
                j -= 1
            if backslashes % 2 == 1:
                return True
    return False


def assert_portable_pattern(pattern: Any, label: str) -> None:
    """pydantic v2's Rust-backed regex engine (used by gen-pydantic) does not support lookaround
    or backreferences — both are valid Python `re` / JS RegExp syntax, so a pattern using either
    builds fine in gen-zod but crashes gen-pydantic's entire model build. Reject non-portable
    patterns at DECORATION time (before either generator ever sees the IR), in both languages —
    see contracts/rules/entity-spec-validation.md.
    """
    if pattern is None:
        return
    for marker in _LOOKAROUND_MARKERS:
        if marker in pattern:
            raise ValueError(
                f"{label}: pattern {pattern!r} is not RE2/rust-regex compatible (contains "
                f"lookaround {marker!r}) — see contracts/rules/entity-spec-validation.md"
            )
    if _has_backreference(pattern):
        raise ValueError(
            f"{label}: pattern {pattern!r} is not RE2/rust-regex compatible (contains a "
            f"backreference) — see contracts/rules/entity-spec-validation.md"
        )


__all__ = [
    "RESERVED_WIRE_NAMES",
    "assert_enum_nonempty",
    "assert_format_pattern_exclusive",
    "assert_integer_or_none",
    "assert_portable_pattern",
    "assert_wire_name_not_reserved",
]

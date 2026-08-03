"""P1 gate-review fixes (C4, C5, escalated empty-enum, I-a, I-b1). See
contracts/rules/entity-spec-validation.md for the shared rulings both languages implement, and
node/packages/entity/src/validate.spec.ts for the Node twin these mirror.
"""

from typing import Annotated

import pytest

from server_decorator_entity import (
    EnumOf,
    Float,
    Id,
    Int,
    ListOf,
    Obj,
    Ref,
    Str,
    action,
    entity_spec,
    restful,
)


def test_empty_transports_raises() -> None:
    with pytest.raises(ValueError, match="transports must not be empty"):

        @restful(path="x1", transports=[])
        class X1:
            id: Annotated[str, Id()]


def test_empty_ops_raises() -> None:
    with pytest.raises(ValueError, match="ops must not be empty"):

        @restful(path="x2", ops=[])
        class X2:
            id: Annotated[str, Id()]


def test_empty_enum_raises() -> None:
    with pytest.raises(ValueError, match="enum must have at least one value"):

        @restful(path="x3")
        class X3:
            id: Annotated[str, Id()]
            status: Annotated[str, EnumOf()]


def test_non_integer_min_raises() -> None:
    with pytest.raises(ValueError, match=r"min/max must be integers"):

        @restful(path="x4")
        class X4:
            id: Annotated[str, Id()]
            b: Annotated[int, Int(min=2.5)]  # type: ignore[arg-type]


def test_non_integer_max_raises() -> None:
    with pytest.raises(ValueError, match=r"min/max must be integers"):

        @restful(path="x5")
        class X5:
            id: Annotated[str, Id()]
            b: Annotated[float, Float(max=2.5)]


def test_bool_min_raises_even_though_isinstance_int_is_true() -> None:
    with pytest.raises(ValueError, match=r"min/max must be integers"):

        @restful(path="x5b")
        class X5b:
            id: Annotated[str, Id()]
            b: Annotated[int, Int(min=True)]  # type: ignore[arg-type]


def test_format_and_pattern_together_raises() -> None:
    with pytest.raises(ValueError, match="format and pattern are mutually exclusive"):

        @restful(path="x6")
        class X6:
            id: Annotated[str, Id()]
            e: Annotated[str, Str(format="email", pattern="^admin@")]


def test_reserved_wire_name_raises() -> None:
    with pytest.raises(ValueError, match="reserved"):

        @restful(path="x7")
        class X7:
            id: Annotated[str, Id()]
            copy: Annotated[str, Str()]


def test_reserved_wire_name_in_nested_obj_raises() -> None:
    with pytest.raises(ValueError, match="reserved"):

        @restful(path="x8")
        class X8:
            id: Annotated[str, Id()]
            profile: Annotated[dict, Obj([("schema", Str())])]  # type: ignore[type-arg]


def test_reserved_wire_name_in_action_input_raises() -> None:
    with pytest.raises(ValueError, match="reserved"):

        class X9:
            id: Annotated[str, Id()]

            @action("go", input=[("json", Str())])
            def go(self) -> None: ...

        restful(path="x9")(X9)


def test_nested_list_of_list_names_every_level_with_the_parent_field_name() -> None:
    @restful(path="x10")
    class X10:
        id: Annotated[str, Id()]
        grid: Annotated[list, ListOf(ListOf(Str()))]  # type: ignore[type-arg]

    spec = entity_spec(X10)
    grid_field = next(f for f in spec["fields"] if f["name"] == "grid")
    assert grid_field["item"]["name"] == "grid"
    assert grid_field["item"]["item"]["name"] == "grid"


def test_lookahead_pattern_raises() -> None:
    with pytest.raises(ValueError, match=r"not RE2/rust-regex compatible"):

        @restful(path="x12")
        class X12:
            id: Annotated[str, Id()]
            e: Annotated[str, Str(pattern="^(?=.*[0-9]).+$")]


def test_negative_lookahead_pattern_raises() -> None:
    with pytest.raises(ValueError, match="lookaround"):

        @restful(path="x13")
        class X13:
            id: Annotated[str, Id()]
            e: Annotated[str, Str(pattern="^(?!admin).+$")]


def test_lookbehind_pattern_raises() -> None:
    with pytest.raises(ValueError, match="lookaround"):

        @restful(path="x14")
        class X14:
            id: Annotated[str, Id()]
            e: Annotated[str, Str(pattern="(?<=foo)bar")]


def test_backreference_pattern_raises() -> None:
    with pytest.raises(ValueError, match="backreference"):

        @restful(path="x15")
        class X15:
            id: Annotated[str, Id()]
            e: Annotated[str, Str(pattern="(a)\\1")]


def test_normal_portable_pattern_still_works() -> None:
    @restful(path="x16")
    class X16:
        id: Annotated[str, Id()]
        e: Annotated[str, Str(pattern="^[a-z]+$")]

    spec = entity_spec(X16)
    e_field = next(f for f in spec["fields"] if f["name"] == "e")
    assert e_field["pattern"] == "^[a-z]+$"


def test_doubled_backslash_before_digit_does_not_false_positive() -> None:
    # Source pattern characters: ^ a \ \ 1 $ — an escaped backslash (\\) followed by a literal
    # "1", NOT a backreference (\1). The raw Python string r"^a\\1$" contains exactly those six
    # characters (a raw string literal does not collapse \\ to \).
    pattern = r"^a\\1$"
    assert pattern == "^a\\\\1$"  # sanity: 6 chars — ^ a \ \ 1 $

    @restful(path="x17")
    class X17:
        id: Annotated[str, Id()]
        e: Annotated[str, Str(pattern=pattern)]

    spec = entity_spec(X17)
    e_field = next(f for f in spec["fields"] if f["name"] == "e")
    assert e_field["pattern"] == pattern


def test_empty_string_pattern_is_preserved_in_ir() -> None:
    # M4 parity bug: FieldMarker.to_ir used truthiness (`if self.pattern:`), which silently
    # dropped an empty-string pattern from the IR. The TS twin (`str({ pattern: '' })`) spreads
    # the option straight into FieldSpec and only filters `undefined` in canonicalJson, so it
    # keeps `pattern: ''`. The schema (`contracts/schemas/entity-spec.schema.json`) declares
    # `pattern` as a plain `{"type": "string"}` with no minLength, so `""` is schema-valid and
    # must round-trip byte-identically across languages.
    @restful(path="x18")
    class X18:
        id: Annotated[str, Id()]
        e: Annotated[str, Str(pattern="")]

    spec = entity_spec(X18)
    e_field = next(f for f in spec["fields"] if f["name"] == "e")
    assert "pattern" in e_field
    assert e_field["pattern"] == ""


def test_empty_string_ref_is_preserved_in_ir() -> None:
    # Same M4 parity bug, `ref` side: FieldMarker.to_ir used `if self.ref:`, dropping an
    # empty-string ref. The TS twin (`ref('')`) keeps `ref: ''` for the same reason as above.
    @restful(path="x19")
    class X19:
        id: Annotated[str, Id()]
        r: Annotated[dict, Ref("")]  # type: ignore[type-arg]

    spec = entity_spec(X19)
    r_field = next(f for f in spec["fields"] if f["name"] == "r")
    assert "ref" in r_field
    assert r_field["ref"] == ""


def test_valid_entity_unchanged_control_case() -> None:
    @restful(path="x11")
    class X11:
        id: Annotated[str, Id()]
        name: Annotated[str, Str(min=1, max=10)]

    spec = entity_spec(X11)
    assert [f["name"] for f in spec["fields"]] == ["id", "name"]

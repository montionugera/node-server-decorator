"""Payloads pydantic's lax mode accepts that gen-zod and Go dto reject: bool as a number, 0/1 as a
bool, lax datetime strings, and Unicode-aware `\\w`/`\\d`/`\\b`. See "JSON-type strictness",
`type: "datetime"` and "`pattern` character classes are ASCII" in
contracts/rules/entity-spec-validation.md.
"""

from typing import Any

import pydantic
import pytest

from server_decorator_gen_pydantic import create_model_for


def _model(field: dict[str, Any]) -> type[pydantic.BaseModel]:
    return create_model_for({"entity": "Fuzz", "fields": [field]})


def _valid(field: dict[str, Any], value: Any) -> bool:
    try:
        _model(field).model_validate({field["name"]: value})
    except pydantic.ValidationError:
        return False
    return True


@pytest.mark.parametrize("value", [True, False])
@pytest.mark.parametrize("field_type", ["int", "float"])
def test_number_field_rejects_bool(field_type: str, value: bool) -> None:
    assert not _valid({"name": "n", "type": field_type}, value)


@pytest.mark.parametrize("value", [0, 1, 1.0, "true", [], {}])
def test_bool_field_rejects_non_bool(value: Any) -> None:
    assert not _valid({"name": "b", "type": "bool"}, value)


def test_strict_scalars_still_accept_their_own_json_type() -> None:
    assert _valid({"name": "n", "type": "int"}, 5)
    assert _valid({"name": "n", "type": "int"}, 5.0)
    assert not _valid({"name": "n", "type": "int"}, 5.5)
    assert _valid({"name": "n", "type": "float"}, 5)
    assert _valid({"name": "b", "type": "bool"}, False)


@pytest.mark.parametrize(
    "value",
    [
        "2024-01-01 00:00:00Z",
        "2024-01-01t00:00:00z",
        "1704067200",
        "2024-01-01T00:00:00+0100",
        "2024-01-01T00:00:00+01",
        "2024-01-01T00:00:00+24:00",
        "2024-01-01T00:00Z",
        "2024-01-01T00:00:00,5Z",
        "2024-01-01T00:00:00Z\n",
        "2024-02-30T00:00:00Z",
        "٢٠٢٤-01-01T00:00:00Z",
    ],
)
def test_datetime_rejects_non_rfc3339_shapes(value: str) -> None:
    assert not _valid({"name": "at", "type": "datetime"}, value)


@pytest.mark.parametrize(
    "value",
    ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00.123456+07:00", "2024-01-01T23:59:59-23:59"],
)
def test_datetime_accepts_rfc3339(value: str) -> None:
    assert _valid({"name": "at", "type": "datetime"}, value)


@pytest.mark.parametrize(
    ("pattern", "value", "ok"),
    [
        (r"^\w+$", "ab_1", True),
        (r"^\w+$", "กข", False),  # Thai letters
        (r"^\d+$", "123", True),
        (r"^\d+$", "١٢", False),  # Arabic-Indic digits
        (r"^[\w.-]+$", "a.b-c", True),
        (r"^[\w.-]+$", "é", False),
        (r"^\W$", "é", True),  # non-ASCII is a non-word character, as in JS and Go
        (r"^\D$", "\u0661", True),
        (r"^[^\W\d]+$", "ab_", True),
        (r"^[^\W\d]+$", "a1", False),
        (r"^a\b", "aé", True),  # ASCII word boundary between `a` and a non-ASCII letter
        (r"a\B", "aé", False),
        (r"^\\w$", "\\w", True),  # an escaped backslash followed by a literal `w`
    ],
)
def test_pattern_shorthand_classes_are_ascii(pattern: str, value: str, ok: bool) -> None:
    assert _valid({"name": "s", "type": "str", "pattern": pattern}, value) is ok

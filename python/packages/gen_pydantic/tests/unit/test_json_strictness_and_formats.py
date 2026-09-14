"""P1 gate-review fixes (C1 JSON-type strictness, C2 list-item constraints, C3 uuid/uri regexes,
I-b(2) pattern-compile error wrapping). See contracts/rules/entity-spec-validation.md.

C1 explicitly does NOT use a blanket strict=True model config (that would break ISO-string ->
datetime parsing); instead per-type BeforeValidators reject string input to int/float/bool and
non-string input to datetime, while keeping pydantic's lax integral-float -> int coercion
(5.0 -> 5 ok, 5.5 -> rejected), matching zod's z.number().int() behavior on the same JSON shapes.
"""

from typing import Any

import pydantic
import pytest

from server_decorator_gen_pydantic import create_model_for


def _spec(fields: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "specVersion": "1.2.0",
        "entity": "Fuzz",
        "path": "fuzz",
        "transports": ["rest"],
        "ops": ["create"],
        "pagination": "offset",
        "fields": fields,
    }


# --- C1: string input rejected for int/float/bool -----------------------------------------


def test_int_field_rejects_string_input() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "int"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"a": "5"})


def test_int_field_accepts_integral_float_5_point_0() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "int"}]))
    obj = model.model_validate({"a": 5.0})
    assert obj.a == 5  # type: ignore[attr-defined]


def test_int_field_rejects_fractional_float_5_point_5() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "int"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"a": 5.5})


def test_float_field_rejects_string_input() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "float"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"a": "50"})


def test_bool_field_rejects_string_input() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "bool"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"a": "true"})


def test_bool_field_accepts_real_boolean() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "bool"}]))
    obj = model.model_validate({"a": True})
    assert obj.a is True  # type: ignore[attr-defined]


def test_datetime_field_rejects_epoch_int() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "datetime"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"a": 1704067200})


def test_datetime_field_still_accepts_iso_string_with_offset() -> None:
    model = create_model_for(_spec([{"name": "a", "type": "datetime"}]))
    model.model_validate({"a": "2024-01-01T00:00:00Z"})


# --- C2: list item constraints must be enforced, not dropped -------------------------------


_TAGS_MIN2_MAX5 = {
    "name": "tags",
    "type": "list",
    "item": {"name": "tags", "type": "str", "min": 2, "max": 5},
}
_COUNTS_MIN10 = {
    "name": "counts",
    "type": "list",
    "item": {"name": "counts", "type": "int", "min": 10},
}


def test_list_item_min_length_enforced() -> None:
    model = create_model_for(_spec([_TAGS_MIN2_MAX5]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"tags": ["a"]})


def test_list_item_max_length_enforced() -> None:
    model = create_model_for(_spec([_TAGS_MIN2_MAX5]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"tags": ["abcdefgh"]})


def test_list_item_within_bounds_ok() -> None:
    model = create_model_for(_spec([_TAGS_MIN2_MAX5]))
    model.model_validate({"tags": ["abc"]})


def test_list_item_int_min_enforced() -> None:
    model = create_model_for(_spec([_COUNTS_MIN10]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"counts": [1]})


# --- C3: uuid / uri use the shared regexes, not pydantic builtins --------------------------


def test_uuid_format_rejects_non_grouped_hex_string() -> None:
    model = create_model_for(_spec([{"name": "id", "type": "str", "format": "uuid"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"id": "a" * 36})


def test_uuid_format_accepts_well_formed_uuid() -> None:
    model = create_model_for(_spec([{"name": "id", "type": "str", "format": "uuid"}]))
    model.model_validate({"id": "123e4567-e89b-12d3-a456-426614174000"})


def test_uri_format_implemented_and_rejects_non_url() -> None:
    model = create_model_for(_spec([{"name": "link", "type": "str", "format": "uri"}]))
    with pytest.raises(pydantic.ValidationError):
        model.model_validate({"link": "not a url"})


def test_uri_format_accepts_well_formed_uri() -> None:
    model = create_model_for(_spec([{"name": "link", "type": "str", "format": "uri"}]))
    model.model_validate({"link": "https://example.com/a"})


# --- I-b(2): pattern-compile failures re-raised with a clear message -----------------------


def test_lookahead_pattern_raises_clear_valueerror_naming_field_and_pattern() -> None:
    with pytest.raises(ValueError, match=r"lookAheadField"):
        create_model_for(
            _spec([{"name": "lookAheadField", "type": "str", "pattern": "^(?=.*[0-9]).+$"}])
        )

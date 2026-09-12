"""Not covered by the 14 shared contract cases (no such payload exists there yet), but
the corrected semantics must hold: `optional` only controls whether a key may be
*absent*; only `nullable` allows an explicitly-provided `null`. gen-zod matches this
because zod's `.optional()` and `.nullable()` are independent wrappers.
"""

from typing import Any

import pydantic
import pytest

from server_decorator_gen_pydantic import create_model_for, validation_error_fields

SPEC: dict[str, Any] = {
    "specVersion": "1.2.0",
    "entity": "Widget",
    "path": "widgets",
    "transports": ["rest"],
    "ops": ["create"],
    "pagination": "offset",
    "fields": [
        {"name": "nickname", "type": "str", "optional": True},  # optional, NOT nullable
        {"name": "note", "type": "str", "optional": True, "nullable": True},
    ],
}


def test_optional_non_nullable_field_may_be_absent() -> None:
    model = create_model_for(SPEC)
    model.model_validate({})


def test_optional_non_nullable_field_rejects_explicit_null() -> None:
    model = create_model_for(SPEC)
    with pytest.raises(pydantic.ValidationError) as ei:
        model.model_validate({"nickname": None})
    assert validation_error_fields(ei.value) == ["nickname"]


def test_optional_nullable_field_accepts_explicit_null() -> None:
    model = create_model_for(SPEC)
    model.model_validate({"note": None})

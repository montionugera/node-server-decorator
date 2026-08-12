"""Parity with node/packages/gen-zod/src/nested-field-filtering.spec.ts.

Reviewer finding on the Node twin: the 'obj' branch recursed with a hardcoded
`lambda _f: True`, ignoring the caller's DTO include predicate — so a
readonly/writeonly nested field leaked into every DTO shape regardless of which one
was being built. A synthetic spec (rather than the shared UserFixture, which has no
nested readonly field) isolates the bug for the Python twin too.
"""

from typing import Any

import pydantic
import pytest

from server_decorator_gen_pydantic import create_model_for, read_model_for, validation_error_fields

SPEC: dict[str, Any] = {
    "specVersion": "1.1.0",
    "entity": "Widget",
    "path": "widgets",
    "transports": ["rest"],
    "ops": ["create"],
    "pagination": "offset",
    "fields": [
        {
            "name": "profile",
            "type": "obj",
            "optional": True,
            "fields": [
                {"name": "secret", "type": "str", "readonly": True},
                {"name": "bio", "type": "str", "optional": True},
            ],
        }
    ],
}


def test_create_model_rejects_readonly_nested_field_as_unknown() -> None:
    model = create_model_for(SPEC)
    with pytest.raises(pydantic.ValidationError) as ei:
        model.model_validate({"profile": {"secret": "x"}})
    assert validation_error_fields(ei.value) == ["profile.secret"]


def test_read_model_still_includes_the_readonly_nested_field() -> None:
    model = read_model_for(SPEC)
    model.model_validate({"profile": {"secret": "x"}})

"""1.2.0 IR metadata: description, tags and security (mirror of Node's restful.spec.ts)."""

from typing import Annotated

import pytest

from server_decorator_entity import Id, Str, entity_spec, restful


def test_metadata_flows_into_spec() -> None:
    @restful(
        path="widgets",
        description="A widget",
        tags=["catalog"],
        security={
            "schemes": [{"name": "bearerAuth", "type": "http", "scheme": "bearer"}],
            "ops": {"create": ["widget:write"]},
        },
    )
    class Widget:
        id: Annotated[str, Id()]
        name: Annotated[str, Str(description="Display name")]

    spec = entity_spec(Widget)
    assert spec["description"] == "A widget"
    assert spec["tags"] == ["catalog"]
    assert spec["security"]["ops"]["create"] == ["widget:write"]
    assert spec["fields"][1]["description"] == "Display name"


def test_security_op_must_be_declared() -> None:
    with pytest.raises(ValueError, match=r"security\.ops\.create is not declared in ops"):

        @restful(
            path="widgets",
            ops=["list"],
            security={
                "schemes": [{"name": "bearerAuth", "type": "http", "scheme": "bearer"}],
                "ops": {"create": ["widget:write"]},
            },
        )
        class Widget:
            id: Annotated[str, Id()]


def test_unknown_scheme_type_rejected() -> None:
    with pytest.raises(ValueError, match=r'scheme "x": type must be "http" or "apiKey"'):

        @restful(path="widgets", security={"schemes": [{"name": "x", "type": "oauth2"}]})
        class Widget:
            id: Annotated[str, Id()]

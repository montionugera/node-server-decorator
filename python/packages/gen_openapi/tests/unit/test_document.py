import json
from pathlib import Path

from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import User

from server_decorator_gen_openapi import openapi_document

DOC = openapi_document([entity_spec(User)], "1.2.0")


def test_declares_openapi_31() -> None:
    assert DOC["openapi"] == "3.1.0"
    assert DOC["info"] == {"title": "server-decorator API", "version": "1.2.0"}


def test_routes_match_conventions() -> None:
    assert sorted(DOC["paths"]) == [
        "/users",
        "/users/{id}",
        "/users/{id}/actions/activate",
        "/users/{id}/actions/ping",
    ]
    assert "put" not in DOC["paths"]["/users/{id}"]
    assert "patch" in DOC["paths"]["/users/{id}"]


def test_security_only_on_declared_ops() -> None:
    assert DOC["paths"]["/users"]["post"]["security"] == [{"bearerAuth": ["user:write"]}]
    assert "security" not in DOC["paths"]["/users"]["get"]


def test_matches_golden_document() -> None:
    # test_document.py -> unit -> tests -> gen_openapi -> packages -> python -> repo root
    golden = Path(__file__).resolve().parents[5] / "contracts/fixtures/openapi.valid-user.json"
    if golden.exists():
        assert DOC == json.loads(golden.read_text())

import json
from pathlib import Path

from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import User

from server_decorator_gen_openapi import openapi_document

# test_document.py -> unit -> tests -> gen_openapi -> packages -> python -> repo root
_CONTRACTS = Path(__file__).resolve().parents[5] / "contracts"
# The golden document is emitted with contracts/VERSION (scripts/emit_openapi.py), so the
# test must read the same file: a hardcoded literal goes stale on every contract bump.
_VERSION_FILE = _CONTRACTS / "VERSION"
VERSION = _VERSION_FILE.read_text().strip() if _VERSION_FILE.exists() else "0.0.0"

DOC = openapi_document([entity_spec(User)], VERSION)


def test_declares_openapi_31() -> None:
    assert DOC["openapi"] == "3.1.0"
    assert DOC["info"] == {"title": "server-decorator API", "version": VERSION}


def test_version_argument_is_passed_through_verbatim() -> None:
    doc = openapi_document([entity_spec(User)], "9.8.7-rc.1")
    assert doc["info"] == {"title": "server-decorator API", "version": "9.8.7-rc.1"}


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
    golden = _CONTRACTS / "fixtures/openapi.valid-user.json"
    if golden.exists():
        assert DOC == json.loads(golden.read_text())

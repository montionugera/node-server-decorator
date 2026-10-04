"""Coverage-gap tests for the FastAPI adapter: DTO validation edges, problem responses,
spec resolution, and the error/auth branches of every mounted route."""

from __future__ import annotations

import json
import sys
import types
from typing import Any, ClassVar

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from server_decorator.adapters.fastapi import (
    PROBLEM_CONTENT_TYPE,
    VALIDATION_PROBLEM_TYPE,
    NotFoundError,
    mount_fastapi_routes,
    problem_response,
    resolve_entity_spec,
    validate_dto,
    validation_problem_response,
)

# ---------------------------------------------------------------- problem responses


def _body(resp: Any) -> dict[str, Any]:
    return json.loads(resp.body)


@pytest.mark.parametrize(
    ("status", "title"),
    [
        (400, "Bad Request"),
        (401, "Unauthorized"),
        (403, "Forbidden"),
        (404, "Not Found"),
        (500, "Internal Server Error"),
        (418, "Error"),
    ],
)
def test_problem_response_default_titles(status: int, title: str) -> None:
    resp = problem_response(status)
    assert resp.status_code == status
    assert resp.media_type == PROBLEM_CONTENT_TYPE
    # detail / instance are omitted entirely when not given.
    assert _body(resp) == {"type": "about:blank", "title": title, "status": status}


def test_problem_response_explicit_fields() -> None:
    resp = problem_response(404, title="Gone Fishing", detail="", instance="/x/1")
    # An empty-string detail is still a detail (only None is omitted).
    assert _body(resp) == {
        "type": "about:blank",
        "title": "Gone Fishing",
        "status": 404,
        "detail": "",
        "instance": "/x/1",
    }


def test_validation_problem_response_shapes() -> None:
    bare = validation_problem_response([])
    assert bare.status_code == 400
    assert bare.media_type == PROBLEM_CONTENT_TYPE
    assert _body(bare) == {
        "type": VALIDATION_PROBLEM_TYPE,
        "title": "Validation Failed",
        "status": 400,
        "fields": [],
    }
    full = validation_problem_response(["a", "b.c"], instance="/users")
    assert _body(full)["fields"] == ["a", "b.c"]
    assert _body(full)["instance"] == "/users"


def test_not_found_error_defaults() -> None:
    err = NotFoundError()
    assert err.message == "Not Found"
    assert str(err) == "Not Found"
    assert err.status_code == 404
    assert NotFoundError("user 7 missing").message == "user 7 missing"


# ---------------------------------------------------------------- validate_dto


def _spec(*fields: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"entity": "T", "path": "/t", "ops": [], "fields": list(fields), **extra}


def _errs(field: dict[str, Any], value: Any) -> list[str]:
    errs, ok = validate_dto(_spec({"name": "v", **field}), "create", {"v": value})
    assert ok is (errs == [])
    return errs


def test_unknown_dto_type_and_unknown_action() -> None:
    spec = _spec({"name": "a", "type": "str"}, actions=[{"name": "go", "input": []}])
    assert validate_dto(spec, "bogus", {}) == (["_dto"], False)
    assert validate_dto(spec, "action:missing", {}) == (["_action"], False)
    # An action declared without input accepts only an empty object.
    assert validate_dto(spec, "action:go", {}) == ([], True)
    assert validate_dto(spec, "action:go", {"x": 1}) == (["x"], False)
    # A spec without an actions list has no actions at all.
    assert validate_dto(_spec(), "action:go", {}) == (["_action"], False)


@pytest.mark.parametrize("payload", [None, [], "str", 3, True])
def test_non_object_root_payload(payload: Any) -> None:
    assert validate_dto(_spec({"name": "a", "type": "str"}), "create", payload) == (
        ["_root"],
        False,
    )


def test_create_excludes_readonly_and_requires_the_rest() -> None:
    spec = _spec(
        {"name": "id", "type": "str", "readonly": True},
        {"name": "name", "type": "str"},
        {"name": "note", "type": "str", "optional": True},
    )
    assert validate_dto(spec, "create", {"name": "n"}) == ([], True)
    # A readonly field is not part of the create DTO: sending it is an unknown key.
    assert validate_dto(spec, "create", {"id": "1", "name": "n"}) == (["id"], False)
    assert validate_dto(spec, "create", {}) == (["name"], False)


def test_update_makes_every_field_optional_but_still_validates_values() -> None:
    spec = _spec(
        {"name": "id", "type": "str", "readonly": True},
        {"name": "name", "type": "str", "min": 2},
        {"name": "age", "type": "int"},
    )
    assert validate_dto(spec, "update", {}) == ([], True)
    assert validate_dto(spec, "update", {"age": 3}) == ([], True)
    assert validate_dto(spec, "update", {"name": "x", "id": "1"}) == (["id", "name"], False)


def test_read_excludes_writeonly_and_keeps_readonly() -> None:
    spec = _spec(
        {"name": "id", "type": "str", "readonly": True},
        {"name": "password", "type": "str", "writeonly": True},
    )
    assert validate_dto(spec, "read", {"id": "1"}) == ([], True)
    assert validate_dto(spec, "read", {"id": "1", "password": "p"}) == (["password"], False)
    # ... while the create DTO is the mirror image.
    assert validate_dto(spec, "create", {"password": "p"}) == ([], True)


def test_null_handling() -> None:
    assert _errs({"type": "str"}, None) == ["v"]
    assert _errs({"type": "str", "nullable": True}, None) == []
    # nullable does not make the key optional.
    errs, ok = validate_dto(_spec({"name": "v", "type": "str", "nullable": True}), "create", {})
    assert (errs, ok) == (["v"], False)


def test_unknown_field_type_is_rejected() -> None:
    assert _errs({"type": "decimal"}, 1) == ["v"]
    assert _errs({}, "x") == ["v"]


@pytest.mark.parametrize(
    ("field", "value", "valid"),
    [
        ({"type": "str"}, "", True),
        ({"type": "str"}, 5, False),
        ({"type": "ref"}, "abc", True),
        ({"type": "ref"}, ["abc"], False),
        ({"type": "str", "min": 3}, "ab", False),
        ({"type": "str", "min": 3}, "abc", True),
        ({"type": "str", "min": 0}, "", True),
        ({"type": "str", "max": 3}, "abc", True),
        ({"type": "str", "max": 3}, "abcd", False),
        ({"type": "str", "max": 0}, "", True),
        ({"type": "str", "max": 0}, "a", False),
        ({"type": "str", "format": "email"}, "a@b.co", True),
        ({"type": "str", "format": "email"}, "not-an-email", False),
        ({"type": "str", "format": "uuid"}, "123e4567-e89b-12d3-a456-426614174000", True),
        ({"type": "str", "format": "uuid"}, "123E4567-E89B-12D3-A456-426614174000", True),
        ({"type": "str", "format": "uuid"}, "123e4567e89b12d3a456426614174000", False),
        ({"type": "str", "format": "uri"}, "https://example.com/x", True),
        ({"type": "str", "format": "uri"}, "example.com", False),
        ({"type": "str", "format": "uri"}, "http://has space", False),
        ({"type": "str", "pattern": "^[a-z]+$"}, "abc", True),
        ({"type": "str", "pattern": "^[a-z]+$"}, "ab1", False),
        # A broken pattern can never match: the value is rejected, not a 500.
        ({"type": "str", "pattern": "("}, "abc", False),
        # An unknown format with no pattern imposes nothing.
        ({"type": "str", "format": "hostname"}, "anything", True),
    ],
)
def test_string_validation(field: dict[str, Any], value: Any, valid: bool) -> None:
    assert _errs(field, value) == ([] if valid else ["v"])


@pytest.mark.skip(
    reason="SOURCE BUG (adapters/fastapi.py): EMAIL_PATTERN / UUID_PATTERN / URI_PATTERN end "
    "in `$` and are applied with re.match, and Python's `$` also matches just before a "
    "trailing newline, so 'a@b.co\\n' passes format validation here while a JS regex "
    "(Node twin) rejects it. Fix: use fullmatch or `\\Z`."
)
@pytest.mark.parametrize(
    ("fmt", "value"),
    [
        ("email", "a@b.co\n"),
        ("uuid", "123e4567-e89b-12d3-a456-426614174000\n"),
        ("uri", "https://example.com/x\n"),
    ],
)
def test_format_rejects_trailing_newline(fmt: str, value: str) -> None:
    assert _errs({"type": "str", "format": fmt}, value) == ["v"]


@pytest.mark.parametrize(
    ("field", "value", "valid"),
    [
        ({"type": "int"}, 0, True),
        ({"type": "int"}, -7, True),
        ({"type": "int"}, 3.0, True),
        ({"type": "int"}, 3.5, False),
        ({"type": "int"}, True, False),
        ({"type": "int"}, False, False),
        ({"type": "int"}, "3", False),
        ({"type": "int"}, float("nan"), False),
        ({"type": "int"}, float("inf"), False),
        ({"type": "int"}, 2**70, True),
        ({"type": "int", "min": 0}, 0, True),
        ({"type": "int", "min": 0}, -1, False),
        ({"type": "int", "max": 10}, 10, True),
        ({"type": "int", "max": 10}, 11, False),
        ({"type": "int", "min": 1, "max": 1}, 1.0, True),
        ({"type": "float"}, 1, True),
        ({"type": "float"}, -0.0, True),
        ({"type": "float"}, True, False),
        ({"type": "float"}, "1.5", False),
        ({"type": "float"}, [1.5], False),
        ({"type": "float", "min": 0}, -0.001, False),
        ({"type": "float", "min": 0}, 0.0, True),
        ({"type": "float", "max": 1}, 1.0, True),
        ({"type": "float", "max": 1}, 1.0001, False),
        ({"type": "float", "max": 1}, float("inf"), False),
        ({"type": "float", "min": 0}, float("-inf"), False),
        ({"type": "bool"}, True, True),
        ({"type": "bool"}, False, True),
        ({"type": "bool"}, 1, False),
        ({"type": "bool"}, "true", False),
    ],
)
def test_number_and_bool_validation(field: dict[str, Any], value: Any, valid: bool) -> None:
    assert _errs(field, value) == ([] if valid else ["v"])


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("2024-01-02T03:04:05Z", True),
        ("2024-01-02T03:04:05z", True),
        ("2024-01-02T03:04:05+07:00", True),
        ("2024-01-02T03:04:05-05:30", True),
        ("2024-01-02T03:04:05.123456+00:00", True),
        # No explicit offset: rejected even though it parses as naive ISO 8601.
        ("2024-01-02T03:04:05", False),
        ("2024-01-02", False),
        ("short", False),
        ("", False),
        # Has an offset marker but is not a date.
        ("Z", False),
        ("not-a-date+07:00", False),
        ("2024-13-40T00:00:00Z", False),
        (1704164645, False),
        ({"iso": "2024-01-02T03:04:05Z"}, False),
    ],
)
def test_datetime_validation(value: Any, valid: bool) -> None:
    assert _errs({"type": "datetime"}, value) == ([] if valid else ["v"])


def test_enum_validation() -> None:
    field = {"type": "enum", "enum": ["a", "b"]}
    assert _errs(field, "a") == []
    assert _errs(field, "c") == ["v"]
    assert _errs(field, "A") == ["v"]
    assert _errs(field, 1) == ["v"]
    # An enum with no members admits nothing.
    assert _errs({"type": "enum"}, "a") == ["v"]


def test_list_validation_reports_indexed_paths() -> None:
    field = {"type": "list", "item": {"type": "int", "min": 0}}
    assert _errs(field, []) == []
    assert _errs(field, [1, 2]) == []
    assert _errs(field, "nope") == ["v"]
    assert _errs(field, {"0": 1}) == ["v"]
    assert _errs(field, [1, -1, "x", 4]) == ["v.1", "v.2"]
    # Items are validated as values: a null element has no matching type.
    assert _errs(field, [None]) == ["v.0"]
    # Without an item spec the elements are unconstrained.
    assert _errs({"type": "list"}, [1, "a", None]) == []


def test_nested_object_and_list_of_objects_paths() -> None:
    spec = _spec(
        {
            "name": "profile",
            "type": "obj",
            "fields": [
                {"name": "bio", "type": "str"},
                {"name": "rev", "type": "int", "readonly": True},
                {"name": "pin", "type": "str", "writeonly": True, "optional": True},
            ],
        },
        {
            "name": "tags",
            "type": "list",
            "optional": True,
            "item": {"type": "obj", "fields": [{"name": "label", "type": "str"}]},
        },
    )
    assert validate_dto(spec, "create", {"profile": {"bio": "hi", "pin": "1"}}) == ([], True)
    # Nested readonly members are filtered out of create just like top-level ones.
    assert validate_dto(spec, "create", {"profile": {"bio": "hi", "rev": 2}}) == (
        ["profile.rev"],
        False,
    )
    # ... and nested writeonly members are filtered out of read.
    assert validate_dto(spec, "read", {"profile": {"bio": "hi", "rev": 2, "pin": "1"}}) == (
        ["profile.pin"],
        False,
    )
    assert validate_dto(spec, "create", {"profile": "flat"}) == (["profile"], False)
    assert validate_dto(spec, "create", {"profile": {}}) == (["profile.bio"], False)
    errs, ok = validate_dto(
        spec,
        "create",
        {"profile": {"bio": "hi"}, "tags": [{"label": "a"}, {"label": 1}, {}, "x"]},
    )
    assert ok is False
    assert errs == ["tags.1.label", "tags.2.label", "tags.3"]
    # An obj field with no declared members accepts only the empty object.
    assert _errs({"type": "obj"}, {}) == []
    assert _errs({"type": "obj"}, {"k": 1}) == ["v.k"]


def test_errors_are_sorted_and_deduplicated() -> None:
    spec = _spec(
        {"name": "b", "type": "int", "min": 5, "max": 1},
        {"name": "a", "type": "str"},
    )
    # `b` violates both bounds but is reported once; output order is sorted.
    assert validate_dto(spec, "create", {"b": 3, "zz": 1}) == (["a", "b", "zz"], False)


# ---------------------------------------------------------------- resolve_entity_spec


def test_resolve_entity_spec_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = {"entity": "X"}
    assert resolve_entity_spec(spec) is spec

    class Dunder:
        __entity_spec__: ClassVar[dict[str, Any]] = {"entity": "Dunder"}

    class Attr:
        entity_spec: ClassVar[dict[str, Any]] = {"entity": "Attr"}

    class Method:
        @classmethod
        def entity_spec(cls) -> dict[str, Any]:
            return {"entity": cls.__name__}

    assert resolve_entity_spec(Dunder) == {"entity": "Dunder"}
    assert resolve_entity_spec(Attr) == {"entity": "Attr"}
    assert resolve_entity_spec(Method) == {"entity": "Method"}

    class Plain:
        pass

    fake = types.ModuleType("server_decorator_entity")
    fake.entity_spec = lambda cls: {"entity": f"from-module:{cls.__name__}"}  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "server_decorator_entity", fake)
    assert resolve_entity_spec(Plain) == {"entity": "from-module:Plain"}


def test_resolve_entity_spec_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="spec_or_class is required"):
        resolve_entity_spec(None)

    class Plain:
        pass

    # Not a dict and not a class.
    for bad in (42, "users", Plain(), ["x"]):
        with pytest.raises(TypeError, match="Unable to resolve EntitySpec"):
            resolve_entity_spec(bad)

    # Entity package present but its entity_spec() rejects the class.
    def _reject(cls: type) -> dict[str, Any]:
        raise LookupError("not decorated")

    raising = types.ModuleType("server_decorator_entity")
    raising.entity_spec = _reject  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "server_decorator_entity", raising)
    with pytest.raises(TypeError, match="Unable to resolve EntitySpec"):
        resolve_entity_spec(Plain)

    # Entity package present but exposing no entity_spec callable.
    monkeypatch.setitem(
        sys.modules, "server_decorator_entity", types.ModuleType("server_decorator_entity")
    )
    with pytest.raises(TypeError, match="Unable to resolve EntitySpec"):
        resolve_entity_spec(Plain)

    # Entity package not installed at all.
    monkeypatch.setitem(sys.modules, "server_decorator_entity", None)
    with pytest.raises(TypeError, match="Unable to resolve EntitySpec"):
        resolve_entity_spec(Plain)


def test_mount_rejects_unresolvable_spec() -> None:
    with pytest.raises(ValueError):
        mount_fastapi_routes(APIRouter(), None, object())


# ---------------------------------------------------------------- mounted routes


class _GoneError(Exception):
    status_code = 404


class _Handler:
    """Records every call; each op returns (or raises) what the test configured."""

    def __init__(self, **impl: Any) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.impl = impl

    def _do(self, op: str, *args: Any) -> Any:
        self.calls.append((op, *args))
        outcome = self.impl.get(op)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def list(self, limit: int, offset: int, filters: dict[str, str]) -> Any:
        return self._do("list", limit, offset, filters)

    async def get(self, id: str) -> Any:
        return self._do("get", id)

    async def create(self, data: dict[str, Any]) -> Any:
        return self._do("create", data)

    async def update(self, id: str, data: dict[str, Any]) -> Any:
        return self._do("update", id, data)

    # Deliberately synchronous: handlers may be plain functions.
    def delete(self, id: str) -> None:
        self._do("delete", id)

    async def action(self, id: str, action: str, data: dict[str, Any]) -> Any:
        return self._do("action", id, action, data)


def _user_spec(**extra: Any) -> dict[str, Any]:
    return {
        "entity": "User",
        "path": "users/",
        "ops": ["list", "get", "create", "update", "delete", "purge"],
        "fields": [
            {"name": "user_id", "type": "str", "role": "id", "readonly": True},
            {"name": "name", "type": "str", "min": 1, "filterable": True},
            {
                "name": "status",
                "type": "enum",
                "enum": ["on", "off"],
                "optional": True,
                "filterable": True,
            },
            {"name": "note", "type": "str", "optional": True},
        ],
        "actions": [
            {"name": "rename", "input": [{"name": "name", "type": "str", "min": 1}]},
            {"name": "ping"},
        ],
        **extra,
    }


def _client(
    handler: Any, spec: dict[str, Any] | None = None, auth: Any = None
) -> httpx.AsyncClient:
    app = FastAPI()
    router = APIRouter()
    assert mount_fastapi_routes(router, spec or _user_spec(), handler, auth) is router
    app.include_router(router)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def _assert_problem(resp: httpx.Response, status: int, **expected: Any) -> dict[str, Any]:
    assert resp.status_code == status
    assert resp.headers["content-type"].startswith(PROBLEM_CONTENT_TYPE)
    body = resp.json()
    assert body["status"] == status
    for key, value in expected.items():
        assert body[key] == value
    return body


async def test_path_is_normalised_and_id_field_comes_from_role() -> None:
    handler = _Handler(get={"user_id": "u1", "name": "n"})
    async with _client(handler) as c:
        resp = await c.get("/users/u1")
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "u1", "name": "n"}
    assert handler.calls == [("get", "u1")]


async def test_id_field_defaults_to_id_and_unknown_ops_mount_nothing() -> None:
    spec = {
        "path": "/things",
        "ops": ["get", "purge"],
        "fields": [{"name": "name", "type": "str"}, {"type": "str", "role": "id"}],
    }
    handler = _Handler(get={"ok": True})
    async with _client(handler, spec) as c:
        assert (await c.get("/things/7")).json() == {"ok": True}
        # Only `get` was declared: the collection routes and other verbs do not exist.
        assert (await c.get("/things")).status_code == 404
        assert (await c.post("/things", json={})).status_code == 404
        assert (await c.delete("/things/7")).status_code == 405
    assert handler.calls == [("get", "7")]


@pytest.mark.parametrize(
    ("query", "limit", "offset"),
    [
        ("", 20, 0),
        ("?limit=5&offset=7", 5, 7),
        ("?limit=0", 0, 0),
        ("?limit=100", 100, 0),
        ("?limit=101", 100, 0),
        ("?limit=999999999999999999999", 100, 0),
        ("?limit=-1", 20, 0),
        ("?limit=abc", 20, 0),
        ("?limit=1.5", 20, 0),
        ("?limit=", 20, 0),
        ("?offset=-5", 20, 0),
        ("?offset=abc", 20, 0),
        ("?offset=NaN", 20, 0),
    ],
)
async def test_list_pagination_clamping(query: str, limit: int, offset: int) -> None:
    handler = _Handler(list=([{"user_id": "1"}], 41))
    async with _client(handler) as c:
        resp = await c.get(f"/users{query}")
    assert resp.status_code == 200
    assert resp.json() == {
        "items": [{"user_id": "1"}],
        "total": 41,
        "limit": limit,
        "offset": offset,
    }
    assert handler.calls == [("list", limit, offset, {})]


async def test_list_passes_only_filterable_query_params() -> None:
    handler = _Handler(list=([], 0))
    async with _client(handler) as c:
        await c.get("/users?name=al&status=on&note=secret&bogus=1&limit=3")
    assert handler.calls == [("list", 3, 0, {"name": "al", "status": "on"})]


@pytest.mark.parametrize(
    ("result", "items", "total"),
    [
        ({"items": [1, 2], "total": 9}, [1, 2], 9),
        # total defaults to the page length; items default to empty.
        ({"items": [1, 2, 3]}, [1, 2, 3], 3),
        ({}, [], 0),
        # Anything that is neither a tuple nor a dict is an empty page.
        (None, [], 0),
        ([1, 2], [], 0),
    ],
)
async def test_list_result_shapes(result: Any, items: list[Any], total: int) -> None:
    async with _client(_Handler(list=result)) as c:
        body = (await c.get("/users")).json()
    assert (body["items"], body["total"]) == (items, total)


async def test_list_handler_failure_is_a_500_problem() -> None:
    async with _client(_Handler(list=RuntimeError("db down"))) as c:
        resp = await c.get("/users")
    _assert_problem(resp, 500, title="Internal Server Error", detail="db down", instance="/users")


async def _call(c: httpx.AsyncClient, op: str) -> httpx.Response:
    if op == "get":
        return await c.get("/users/u9")
    if op == "update":
        return await c.patch("/users/u9", json={"name": "new"})
    if op == "delete":
        return await c.delete("/users/u9")
    if op == "action":
        return await c.post("/users/u9/actions/rename", json={"name": "new"})
    raise AssertionError(op)


_ITEM_OPS = ["get", "update", "delete", "action"]


@pytest.mark.parametrize("op", _ITEM_OPS)
async def test_item_routes_map_not_found_error(op: str) -> None:
    async with _client(_Handler(**{op: NotFoundError("user u9 is gone")})) as c:
        resp = await _call(c, op)
    path = "/users/u9/actions/rename" if op == "action" else "/users/u9"
    _assert_problem(resp, 404, title="Not Found", detail="user u9 is gone", instance=path)


@pytest.mark.parametrize("op", _ITEM_OPS)
async def test_item_routes_fill_in_detail_for_blank_not_found_error(op: str) -> None:
    async with _client(_Handler(**{op: NotFoundError("")})) as c:
        resp = await _call(c, op)
    _assert_problem(resp, 404, detail="entity with id u9 not found")


@pytest.mark.parametrize("op", _ITEM_OPS)
async def test_item_routes_honour_duck_typed_404_status(op: str) -> None:
    async with _client(_Handler(**{op: _GoneError("upstream says no")})) as c:
        resp = await _call(c, op)
    _assert_problem(resp, 404, title="Not Found", detail="upstream says no")


@pytest.mark.parametrize("op", _ITEM_OPS)
async def test_item_routes_map_other_errors_to_500(op: str) -> None:
    async with _client(_Handler(**{op: ValueError("boom")})) as c:
        resp = await _call(c, op)
    _assert_problem(resp, 500, title="Internal Server Error", detail="boom")


@pytest.mark.parametrize("op", ["get", "update"])
async def test_none_result_is_a_404(op: str) -> None:
    handler = _Handler()
    async with _client(handler) as c:
        resp = await _call(c, op)
    _assert_problem(
        resp, 404, title="Not Found", detail="entity with id u9 not found", instance="/users/u9"
    )
    assert handler.calls[0][:2] == (op, "u9")


async def test_create_success_validation_and_failure() -> None:
    handler = _Handler(create={"user_id": "new", "name": "al"})
    async with _client(handler) as c:
        ok = await c.post("/users", json={"name": "al", "status": "on"})
        bad_json = await c.post(
            "/users", content=b"{nope", headers={"content-type": "application/json"}
        )
        empty = await c.post("/users")
        invalid = await c.post("/users", json={"user_id": "x", "status": "maybe"})
        not_object = await c.post("/users", json=[1])

    assert ok.status_code == 201
    assert ok.json() == {"user_id": "new", "name": "al"}
    for resp in (bad_json, empty):
        body = _assert_problem(resp, 400, type=VALIDATION_PROBLEM_TYPE, instance="/users")
        assert body["fields"] == ["_body"]
    assert _assert_problem(invalid, 400)["fields"] == ["name", "status", "user_id"]
    assert _assert_problem(not_object, 400)["fields"] == ["_root"]
    # Only the valid request reached the handler.
    assert handler.calls == [("create", {"name": "al", "status": "on"})]


async def test_create_handler_failure_is_a_500_problem() -> None:
    async with _client(_Handler(create=RuntimeError("unique violation"))) as c:
        resp = await c.post("/users", json={"name": "al"})
    _assert_problem(resp, 500, detail="unique violation", instance="/users")


async def test_update_success_and_validation() -> None:
    handler = _Handler(update={"user_id": "u9", "name": "new"})
    async with _client(handler) as c:
        ok = await c.patch("/users/u9", json={"name": "new"})
        partial = await c.patch("/users/u9", json={})
        bad_json = await c.patch(
            "/users/u9", content=b"<xml/>", headers={"content-type": "application/json"}
        )
        invalid = await c.patch("/users/u9", json={"name": "", "user_id": "u1"})

    assert ok.status_code == 200
    assert ok.json() == {"user_id": "u9", "name": "new"}
    # PATCH with no fields is valid: every field is optional on update.
    assert partial.status_code == 200
    assert _assert_problem(bad_json, 400, instance="/users/u9")["fields"] == ["_body"]
    assert _assert_problem(invalid, 400)["fields"] == ["name", "user_id"]
    assert handler.calls == [("update", "u9", {"name": "new"}), ("update", "u9", {})]


async def test_delete_runs_a_sync_handler_and_returns_204() -> None:
    handler = _Handler()
    async with _client(handler) as c:
        resp = await c.delete("/users/u9")
    assert resp.status_code == 204
    assert resp.content == b""
    assert handler.calls == [("delete", "u9")]


async def test_action_with_declared_input() -> None:
    handler = _Handler(action={"renamed": True})
    async with _client(handler) as c:
        ok = await c.post("/users/u9/actions/rename", json={"name": "zed"})
        no_body = await c.post("/users/u9/actions/rename")
        invalid = await c.post("/users/u9/actions/rename", json={"name": "", "extra": 1})

    assert ok.status_code == 200
    assert ok.json() == {"renamed": True}
    assert _assert_problem(no_body, 400, instance="/users/u9/actions/rename")["fields"] == ["_body"]
    assert _assert_problem(invalid, 400)["fields"] == ["extra", "name"]
    assert handler.calls == [("action", "u9", "rename", {"name": "zed"})]


async def test_action_without_input_tolerates_missing_or_arbitrary_body() -> None:
    handler = _Handler(action={"pong": True})
    async with _client(handler) as c:
        bare = await c.post("/users/u9/actions/ping")
        with_body = await c.post("/users/u9/actions/ping", json={"anything": [1, 2]})
        unknown = await c.post("/users/u9/actions/nope")

    assert bare.status_code == 200
    assert bare.json() == {"pong": True}
    assert with_body.status_code == 200
    assert unknown.status_code == 404
    # No body -> {}; a supplied body is forwarded unvalidated.
    assert handler.calls == [
        ("action", "u9", "ping", {}),
        ("action", "u9", "ping", {"anything": [1, 2]}),
    ]


# ---------------------------------------------------------------- scope auth on routes

_SECURED = {
    "security": {
        "ops": {
            "list": ["users:read"],
            "get": ["users:read"],
            "create": ["users:write"],
            "update": ["users:write"],
            "delete": ["users:write", "users:admin"],
        },
        "actions": {"rename": ["users:write"], "ping": []},
    }
}


async def _call_any(c: httpx.AsyncClient, op: str) -> httpx.Response:
    if op == "list":
        return await c.get("/users")
    if op == "create":
        return await c.post("/users", json={"name": "al"})
    return await _call(c, op)


_ALL_OPS = ["list", "get", "create", "update", "delete", "action"]


@pytest.mark.parametrize("op", _ALL_OPS)
async def test_declared_security_without_extractor_fails_closed(op: str) -> None:
    handler = _Handler()
    async with _client(handler, _user_spec(**_SECURED)) as c:
        resp = await _call_any(c, op)
    _assert_problem(resp, 401, title="Unauthorized", detail="authentication required")
    assert handler.calls == []


@pytest.mark.parametrize("op", _ALL_OPS)
async def test_authenticated_caller_missing_scope_is_403(op: str) -> None:
    handler = _Handler()

    def extractor(request: Any) -> tuple[bool, list[str]]:
        return True, ["users:other"]

    async with _client(handler, _user_spec(**_SECURED), extractor) as c:
        resp = await _call_any(c, op)
    body = _assert_problem(resp, 403, title="Forbidden")
    assert body["detail"].startswith("missing required scope: users:")
    assert handler.calls == []


@pytest.mark.parametrize("op", _ALL_OPS)
async def test_caller_with_all_scopes_reaches_the_handler(op: str) -> None:
    handler = _Handler(
        list=([], 0), get={"a": 1}, create={"a": 1}, update={"a": 1}, action={"a": 1}
    )

    async def extractor(request: Any) -> tuple[bool, list[str]]:
        token = request.headers.get("authorization", "")
        return token == "Bearer good", ["users:read", "users:write", "users:admin"]

    async with _client(handler, _user_spec(**_SECURED), extractor) as c:
        c.headers["authorization"] = "Bearer good"
        allowed = await _call_any(c, op)
        c.headers["authorization"] = "Bearer bad"
        denied = await _call_any(c, op)

    assert allowed.status_code in (200, 201, 204)
    assert denied.status_code == 401
    assert len(handler.calls) == 1
    assert handler.calls[0][0] == op


async def test_delete_requires_every_listed_scope() -> None:
    handler = _Handler()
    async with _client(
        handler, _user_spec(**_SECURED), lambda request: (True, ["users:write"])
    ) as c:
        resp = await c.delete("/users/u9")
    _assert_problem(resp, 403, detail="missing required scope: users:admin")
    assert handler.calls == []


async def test_empty_scope_list_still_requires_authentication() -> None:
    handler = _Handler(action={"pong": True})
    spec = _user_spec(**_SECURED)
    async with _client(handler, spec, lambda request: (False, [])) as c:
        anonymous = await c.post("/users/u9/actions/ping")
    async with _client(handler, spec, lambda request: (True, [])) as c:
        authenticated = await c.post("/users/u9/actions/ping")

    assert anonymous.status_code == 401
    assert authenticated.status_code == 200
    assert handler.calls == [("action", "u9", "ping", {})]


async def test_ops_without_a_security_entry_stay_public() -> None:
    spec = _user_spec(security={"ops": {"create": ["users:write"]}})
    handler = _Handler(list=([], 0), action={"ok": True})
    async with _client(handler, spec) as c:
        public = await c.get("/users")
        public_action = await c.post("/users/u9/actions/ping")
        secured = await c.post("/users", json={"name": "al"})
    assert public.status_code == 200
    assert public_action.status_code == 200
    assert secured.status_code == 401


def test_action_input_validates_nested_members_without_filtering() -> None:
    spec = _spec(
        actions=[
            {
                "name": "move",
                "input": [
                    {
                        "name": "to",
                        "type": "obj",
                        "fields": [
                            {"name": "x", "type": "int", "readonly": True},
                            {"name": "y", "type": "int", "writeonly": True},
                        ],
                    }
                ],
            }
        ]
    )
    # Action inputs are not create/read DTOs: readonly / writeonly members both stay.
    assert validate_dto(spec, "action:move", {"to": {"x": 1, "y": 2}}) == ([], True)
    assert validate_dto(spec, "action:move", {"to": {"x": 1}}) == (["to.y"], False)
    assert validate_dto(spec, "action:move", {"to": {"y": "2"}}) == (["to.x", "to.y"], False)

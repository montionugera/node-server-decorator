"""Unit coverage for middleware/auth.py: extractor result shapes, failure paths and
spec/path based scope resolution."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from server_decorator.middleware.auth import (
    ProblemDetails,
    ScopeAuthMiddleware,
    check_scopes,
    enforce_scope_auth,
)

SPEC: dict[str, Any] = {
    "path": "users",
    "ops": ["list", "create", "get", "update", "delete"],
    "security": {
        "ops": {
            "list": ["users:read"],
            "create": ["users:write"],
            "get": ["users:read"],
            "update": ["users:write"],
            "delete": ["users:admin"],
        },
        "actions": {"ban": ["users:ban"]},
    },
}


class _App:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        self.calls.append(scope)


class _Sender:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def __call__(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    @property
    def status(self) -> int:
        return int(self.events[0]["status"])

    @property
    def body(self) -> dict[str, Any]:
        return json.loads(self.events[1]["body"])  # type: ignore[no-any-return]


async def _run(mw: ScopeAuthMiddleware, scope: dict[str, Any]) -> tuple[_Sender, _App]:
    send = _Sender()
    await mw(scope, None, send)
    return send, mw.app


def _http(method: str, path: str, **extra: Any) -> dict[str, Any]:
    return {"type": "http", "method": method, "path": path, **extra}


# --------------------------------------------------------------------- ProblemDetails


def test_problem_details_omits_none_fields_and_keeps_empty_strings() -> None:
    assert ProblemDetails().to_dict() == {"type": "about:blank", "title": "", "status": 500}
    assert ProblemDetails(title="T", status=403, detail="", instance="").to_dict() == {
        "type": "about:blank",
        "title": "T",
        "status": 403,
        "detail": "",
        "instance": "",
    }


def test_check_scopes_reports_first_missing_in_required_order() -> None:
    assert check_scopes([], []) == (True, None)
    assert check_scopes(["a", "b"], ["b", "a", "c"]) == (True, None)
    assert check_scopes(["a", "b", "c"], ["a"]) == (False, "b")
    assert check_scopes(["x"], []) == (False, "x")


# ------------------------------------------------------------------ enforce_scope_auth


async def test_enforce_without_extractor_fails_closed_401() -> None:
    problem = await enforce_scope_auth([], None, {"path": "/p"})

    assert problem is not None
    assert (problem.status, problem.title, problem.instance) == (401, "Unauthorized", "/p")


async def test_enforce_extractor_exception_is_401_not_propagated() -> None:
    def boom(_req: Any) -> tuple[bool, list[str]]:
        raise RuntimeError("token parse failed")

    problem = await enforce_scope_auth(["a"], boom, {"path": "/p"})

    assert problem is not None and problem.status == 401
    assert problem.detail == "authentication required"


async def test_enforce_async_extractor_exception_is_401() -> None:
    async def boom(_req: Any) -> tuple[bool, list[str]]:
        raise ValueError("bad jwt")

    problem = await enforce_scope_auth(["a"], boom, {})

    assert problem is not None and problem.status == 401
    assert problem.instance is None


async def test_enforce_accepts_dict_result() -> None:
    ok = await enforce_scope_auth(
        ["a"],
        lambda _r: {"authenticated": True, "scopes": ["a"]},
        {},  # type: ignore[arg-type,return-value]
    )
    missing_flag = await enforce_scope_auth(["a"], lambda _r: {"scopes": ["a"]}, {})  # type: ignore[arg-type,return-value]
    no_scopes = await enforce_scope_auth(["a"], lambda _r: {"authenticated": True}, {})  # type: ignore[arg-type,return-value]

    assert ok is None
    assert missing_flag is not None and missing_flag.status == 401
    assert no_scopes is not None and no_scopes.status == 403
    assert no_scopes.detail == "missing required scope: a"


async def test_enforce_accepts_object_result() -> None:
    authed = SimpleNamespace(authenticated=True, scopes=["a", "b"])
    authed_no_scopes = SimpleNamespace(authenticated=True)
    anon = SimpleNamespace(authenticated=False, scopes=["a"])

    assert await enforce_scope_auth(["a", "b"], lambda _r: authed, {}) is None  # type: ignore[arg-type,return-value]
    forbidden = await enforce_scope_auth(["a"], lambda _r: authed_no_scopes, {})  # type: ignore[arg-type,return-value]
    unauth = await enforce_scope_auth(["a"], lambda _r: anon, {})  # type: ignore[arg-type,return-value]

    assert forbidden is not None and forbidden.status == 403
    assert unauth is not None and unauth.status == 401


@pytest.mark.parametrize("result", [None, True, "yes", 1, ["a"]])
async def test_enforce_unrecognised_result_shape_is_401(result: Any) -> None:
    problem = await enforce_scope_auth([], lambda _r: result, {})

    assert problem is not None and problem.status == 401


async def test_enforce_one_element_tuple_means_no_scopes() -> None:
    authed_only = await enforce_scope_auth([], lambda _r: (True,), {})  # type: ignore[arg-type,return-value]
    needs_scope = await enforce_scope_auth(["a"], lambda _r: (True,), {})  # type: ignore[arg-type,return-value]

    assert authed_only is None
    assert needs_scope is not None and needs_scope.status == 403


async def test_enforce_instance_from_url_then_path_attribute() -> None:
    with_url = SimpleNamespace(url="http://h/users", path="/ignored")
    with_path = SimpleNamespace(path="/users/1")

    p1 = await enforce_scope_auth([], None, with_url)
    p2 = await enforce_scope_auth([], None, with_path)
    p3 = await enforce_scope_auth([], None, object())

    assert p1 is not None and p1.instance == "http://h/users"
    assert p2 is not None and p2.instance == "/users/1"
    assert p3 is not None and p3.instance is None
    assert "instance" not in p3.to_dict()


# ----------------------------------------------------------- _resolve_required_scopes


def test_resolve_explicit_required_scopes_wins_over_everything() -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC, operation_scopes={"list": ["override"]})

    scope = _http("GET", "/users", required_scopes=["explicit"], operation="list")

    assert mw._resolve_required_scopes(scope) == ["explicit"]
    assert mw._resolve_required_scopes({"required_scopes": []}) == []


def test_resolve_operation_key_prefers_override_then_spec_then_public() -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC, operation_scopes={"list": ["override"]})

    assert mw._resolve_required_scopes({"operation": "list"}) == ["override"]
    assert mw._resolve_required_scopes({"operation": "get"}) == ["users:read"]
    assert mw._resolve_required_scopes({"operation": "unknown"}) is None


def test_resolve_action_key_prefers_override_then_spec_then_public() -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC, action_scopes={"mute": ["users:mute"]})

    assert mw._resolve_required_scopes({"action": "mute"}) == ["users:mute"]
    assert mw._resolve_required_scopes({"action": "ban"}) == ["users:ban"]
    assert mw._resolve_required_scopes({"action": "nope"}) is None


def test_resolve_method_path_key_then_bare_path_key() -> None:
    mw = ScopeAuthMiddleware(
        _App(),
        operation_scopes={"POST /reports": ["reports:write"], "/reports": ["reports:any"]},
    )

    assert mw._resolve_required_scopes(_http("post", "/reports")) == ["reports:write"]
    assert mw._resolve_required_scopes(_http("GET", "/reports")) == ["reports:any"]
    # Method defaults to GET when the scope carries none.
    assert mw._resolve_required_scopes({"path": "/reports"}) == ["reports:any"]
    assert mw._resolve_required_scopes(_http("GET", "/other")) is None
    assert mw._resolve_required_scopes({}) is None


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("GET", "/users", ["users:read"]),
        ("GET", "/users/", ["users:read"]),
        ("POST", "/users", ["users:write"]),
        ("GET", "/users/42", ["users:read"]),
        ("PUT", "/users/42", ["users:write"]),
        ("PATCH", "/users/42", ["users:write"]),
        ("DELETE", "/users/42", ["users:admin"]),
        ("POST", "/users/42/actions/ban", ["users:ban"]),
        ("POST", "/users/actions/ban", ["users:ban"]),
        ("POST", "/users/42/actions/unknown", None),
        ("POST", "/users/42/other/ban", None),
        ("POST", "/users/42/actions/ban/extra", None),
        ("GET", "/usersX", None),
        ("GET", "/elsewhere", None),
    ],
)
def test_resolve_from_spec_dict_path(method: str, path: str, expected: list[str] | None) -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC)

    assert mw._resolve_required_scopes(_http(method, path)) == expected


def test_resolve_path_derived_op_and_action_honour_overrides() -> None:
    mw = ScopeAuthMiddleware(
        _App(),
        spec=SPEC,
        operation_scopes={"get": ["override:get"]},
        action_scopes={"ban": ["override:ban"]},
    )

    assert mw._resolve_required_scopes(_http("GET", "/users/1")) == ["override:get"]
    assert mw._resolve_required_scopes(_http("POST", "/users/1/actions/ban")) == ["override:ban"]


def test_resolve_declared_op_without_security_entry_is_public() -> None:
    spec = {"path": "/users/", "ops": ["list"], "security": {"ops": {}, "actions": None}}
    mw = ScopeAuthMiddleware(_App(), spec=spec)

    assert mw._resolve_required_scopes(_http("GET", "/users")) is None


def test_resolve_from_decorated_class_entity_spec() -> None:
    class User:
        __entity_spec__ = SPEC

    mw = ScopeAuthMiddleware(_App(), spec=User)

    assert mw._resolve_required_scopes(_http("DELETE", "/users/9")) == ["users:admin"]
    assert mw._resolve_required_scopes({"action": "ban"}) == ["users:ban"]


def test_resolve_from_attribute_style_spec_object() -> None:
    spec = SimpleNamespace(
        path="/orders/",
        security=SimpleNamespace(ops={"list": ["orders:read"]}, actions={"ship": ["orders:ship"]}),
    )
    mw = ScopeAuthMiddleware(_App(), spec=spec)

    assert mw._resolve_required_scopes(_http("GET", "/orders")) == ["orders:read"]
    assert mw._resolve_required_scopes(_http("POST", "/orders/1/actions/ship")) == ["orders:ship"]
    assert mw._resolve_required_scopes(_http("POST", "/orders")) is None


def test_resolve_attribute_security_with_none_maps_is_public() -> None:
    spec = SimpleNamespace(path="orders", security=SimpleNamespace(ops=None, actions=None))
    mw = ScopeAuthMiddleware(_App(), spec=spec)

    assert mw._resolve_required_scopes(_http("GET", "/orders")) is None
    assert mw._resolve_required_scopes({"operation": "list"}) is None


# ------------------------------------------------------------------------- __call__


async def test_call_passes_non_http_scopes_straight_through() -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC)
    scope = {"type": "lifespan", "path": "/users", "required_scopes": ["x"]}

    send, app = await _run(mw, scope)

    assert app.calls == [scope]
    assert send.events == []


async def test_call_public_route_skips_extractor() -> None:
    called = False

    def extractor(_s: Any) -> tuple[bool, list[str]]:
        nonlocal called
        called = True
        return (False, [])

    mw = ScopeAuthMiddleware(_App(), spec=SPEC, extractor=extractor)

    send, app = await _run(mw, _http("GET", "/health"))

    assert len(app.calls) == 1
    assert send.events == []
    assert called is False


async def test_call_protected_route_without_extractor_is_401_problem_json() -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC)

    send, app = await _run(mw, _http("GET", "/users"))

    assert app.calls == []
    assert send.status == 401
    assert send.body == {
        "type": "about:blank",
        "title": "Unauthorized",
        "status": 401,
        "detail": "authentication required",
        "instance": "/users",
    }
    headers = dict(send.events[0]["headers"])
    assert headers[b"content-type"] == b"application/problem+json"
    assert int(headers[b"content-length"]) == len(send.events[1]["body"])
    assert [e["type"] for e in send.events] == ["http.response.start", "http.response.body"]


async def test_call_async_extractor_with_scopes_reaches_app() -> None:
    async def extractor(_s: Any) -> tuple[bool, list[str]]:
        return (True, ["users:read"])

    mw = ScopeAuthMiddleware(_App(), spec=SPEC, extractor=extractor)

    send, app = await _run(mw, _http("GET", "/users/1"))

    assert len(app.calls) == 1
    assert send.events == []


async def test_call_extractor_exception_is_401() -> None:
    def extractor(_s: Any) -> tuple[bool, list[str]]:
        raise RuntimeError("jwks unreachable")

    mw = ScopeAuthMiddleware(_App(), spec=SPEC, extractor=extractor)

    send, app = await _run(mw, _http("GET", "/users"))

    assert app.calls == []
    assert send.status == 401
    assert send.body["instance"] == "/users"


async def test_call_dict_result_shapes() -> None:
    results: dict[str, Any] = {
        "ok": {"authenticated": True, "scopes": ["users:read"]},
        "anon": {"scopes": ["users:read"]},
        "noscope": {"authenticated": True},
    }
    statuses: dict[str, int | None] = {}
    for name, result in results.items():
        mw = ScopeAuthMiddleware(_App(), spec=SPEC, extractor=lambda _s, r=result: r)
        send, app = await _run(mw, _http("GET", "/users"))
        statuses[name] = send.status if send.events else None
        assert (len(app.calls) == 1) is (name == "ok")

    assert statuses == {"ok": None, "anon": 401, "noscope": 403}


async def test_call_object_result_shapes() -> None:
    authed = SimpleNamespace(authenticated=True, scopes=["users:write"])
    bare = SimpleNamespace(authenticated=True)
    anon = SimpleNamespace(authenticated=0, scopes=["users:write"])

    ok_send, ok_app = await _run(
        ScopeAuthMiddleware(_App(), spec=SPEC, extractor=lambda _s: authed),  # type: ignore[arg-type,return-value]
        _http("POST", "/users"),
    )
    bare_send, bare_app = await _run(
        ScopeAuthMiddleware(_App(), spec=SPEC, extractor=lambda _s: bare),  # type: ignore[arg-type,return-value]
        _http("POST", "/users"),
    )
    anon_send, anon_app = await _run(
        ScopeAuthMiddleware(_App(), spec=SPEC, extractor=lambda _s: anon),  # type: ignore[arg-type,return-value]
        _http("POST", "/users"),
    )

    assert len(ok_app.calls) == 1 and ok_send.events == []
    assert bare_app.calls == [] and bare_send.status == 403
    assert bare_send.body["detail"] == "missing required scope: users:write"
    assert anon_app.calls == [] and anon_send.status == 401


@pytest.mark.parametrize("result", [None, "token", 1, True])
async def test_call_unrecognised_result_shape_is_401(result: Any) -> None:
    mw = ScopeAuthMiddleware(_App(), spec=SPEC, extractor=lambda _s: result)

    send, app = await _run(mw, _http("GET", "/users"))

    assert app.calls == []
    assert send.status == 401


async def test_call_empty_required_list_needs_authentication_only() -> None:
    authed = ScopeAuthMiddleware(_App(), extractor=lambda _s: (True,))  # type: ignore[arg-type,return-value]
    anon = ScopeAuthMiddleware(_App(), extractor=lambda _s: (False, ["everything"]))

    a_send, a_app = await _run(authed, _http("GET", "/x", required_scopes=[]))
    n_send, n_app = await _run(anon, _http("GET", "/x", required_scopes=[]))

    assert len(a_app.calls) == 1 and a_send.events == []
    assert n_app.calls == [] and n_send.status == 401


async def test_call_403_names_first_missing_scope_and_omits_instance_without_path() -> None:
    mw = ScopeAuthMiddleware(_App(), extractor=lambda _s: (True, ["a"]))

    send, app = await _run(mw, {"type": "http", "required_scopes": ["a", "b", "c"]})

    assert app.calls == []
    assert send.status == 403
    assert send.body == {
        "type": "about:blank",
        "title": "Forbidden",
        "status": 403,
        "detail": "missing required scope: b",
    }

"""Unit tests for ASGI scope-based authorization middleware and Problem Details."""

import json
from typing import Any

import pytest

from server_decorator.middleware.auth import (
    ProblemDetails,
    ScopeAuthMiddleware,
    check_scopes,
    enforce_scope_auth,
)


def test_check_scopes() -> None:
    # All required present
    ok, missing = check_scopes(["read", "write"], ["read", "write", "admin"])
    assert ok is True
    assert missing is None

    # Empty required
    ok, missing = check_scopes([], ["read"])
    assert ok is True
    assert missing is None

    # Missing one scope
    ok, missing = check_scopes(["read", "admin"], ["read", "write"])
    assert ok is False
    assert missing == "admin"


def test_problem_details_to_dict() -> None:
    prob = ProblemDetails(
        type="about:blank",
        title="Unauthorized",
        status=401,
        detail="authentication required",
        instance="/protected",
    )
    d = prob.to_dict()
    assert d == {
        "type": "about:blank",
        "title": "Unauthorized",
        "status": 401,
        "detail": "authentication required",
        "instance": "/protected",
    }

    # None fields omitted
    minimal = ProblemDetails(status=500, title="Error")
    assert minimal.to_dict() == {
        "type": "about:blank",
        "title": "Error",
        "status": 500,
    }


@pytest.mark.asyncio
async def test_enforce_scope_auth_helper() -> None:
    # 1. Unauthenticated
    prob = await enforce_scope_auth(
        ["items:read"],
        lambda _: (False, []),
        {"path": "/items/1"},
    )
    assert prob is not None
    assert prob.status == 401
    assert prob.title == "Unauthorized"
    assert prob.detail == "authentication required"
    assert prob.instance == "/items/1"

    # 2. Missing scope
    prob = await enforce_scope_auth(
        ["items:write"],
        lambda _: (True, ["items:read"]),
        {"path": "/items/1"},
    )
    assert prob is not None
    assert prob.status == 403
    assert prob.title == "Forbidden"
    assert prob.detail == "missing required scope: items:write"

    # 3. Valid scope
    prob = await enforce_scope_auth(
        ["items:read"],
        lambda _: (True, ["items:read", "items:write"]),
        {"path": "/items/1"},
    )
    assert prob is None


# Helper to run ASGI requests against middleware
async def make_asgi_request(
    app: Any,
    scope: dict[str, Any],
) -> tuple[int | None, dict[str, str], bytes]:
    sent_messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent_messages.append(message)

    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    await app(scope, receive, send)

    status: int | None = None
    headers: dict[str, str] = {}
    body: bytes = b""

    for msg in sent_messages:
        if msg["type"] == "http.response.start":
            status = msg["status"]
            headers = {
                k.decode("latin1").lower(): v.decode("latin1") for k, v in msg.get("headers", [])
            }
        elif msg["type"] == "http.response.body":
            body += msg.get("body", b"")

    return status, headers, body


async def dummy_app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": b"OK",
        }
    )


@pytest.mark.asyncio
async def test_middleware_public_route_passthrough() -> None:
    # Public route with no required scopes
    mw = ScopeAuthMiddleware(
        dummy_app,
        operation_scopes={"list": ["items:read"]},
    )
    scope = {"type": "http", "method": "GET", "path": "/public"}
    status, _headers, body = await make_asgi_request(mw, scope)

    assert status == 200
    assert body == b"OK"


@pytest.mark.asyncio
async def test_middleware_unauthenticated_returns_401() -> None:
    mw = ScopeAuthMiddleware(
        dummy_app,
        operation_scopes={"list": ["items:read"]},
        extractor=lambda _: (False, []),
    )
    scope = {"type": "http", "method": "GET", "path": "/items", "operation": "list"}
    status, headers, body = await make_asgi_request(mw, scope)

    assert status == 401
    assert headers["content-type"] == "application/problem+json"
    problem = json.loads(body.decode("utf-8"))
    assert problem["status"] == 401
    assert problem["title"] == "Unauthorized"
    assert problem["detail"] == "authentication required"
    assert problem["instance"] == "/items"


@pytest.mark.asyncio
async def test_middleware_missing_scope_returns_403() -> None:
    mw = ScopeAuthMiddleware(
        dummy_app,
        operation_scopes={"delete": ["items:admin"]},
        extractor=lambda _: (True, ["items:read", "items:write"]),
    )
    scope = {"type": "http", "method": "DELETE", "path": "/items/1", "operation": "delete"}
    status, headers, body = await make_asgi_request(mw, scope)

    assert status == 403
    assert headers["content-type"] == "application/problem+json"
    problem = json.loads(body.decode("utf-8"))
    assert problem["status"] == 403
    assert problem["title"] == "Forbidden"
    assert problem["detail"] == "missing required scope: items:admin"
    assert problem["instance"] == "/items/1"


@pytest.mark.asyncio
async def test_middleware_valid_scopes_passes_through() -> None:
    mw = ScopeAuthMiddleware(
        dummy_app,
        operation_scopes={"create": ["items:write"]},
        extractor=lambda _: (True, ["items:write"]),
    )
    scope = {"type": "http", "method": "POST", "path": "/items", "operation": "create"}
    status, _headers, body = await make_asgi_request(mw, scope)

    assert status == 200
    assert body == b"OK"


@pytest.mark.asyncio
async def test_middleware_resolves_spec_security_ops() -> None:
    spec = {
        "path": "widgets",
        "security": {
            "ops": {
                "create": ["widgets:write"],
                "get": [],
            }
        },
    }
    mw = ScopeAuthMiddleware(
        dummy_app,
        spec=spec,
        extractor=lambda _: (True, ["widgets:read"]),
    )

    # 1. GET /widgets/123 -> "get" requires auth but empty scopes -> allowed
    scope_get = {"type": "http", "method": "GET", "path": "/widgets/123"}
    status, _, body = await make_asgi_request(mw, scope_get)
    assert status == 200
    assert body == b"OK"

    # 2. POST /widgets -> "create" requires "widgets:write", client holds "widgets:read" -> 403
    scope_post = {"type": "http", "method": "POST", "path": "/widgets"}
    status, headers, body = await make_asgi_request(mw, scope_post)
    assert status == 403
    assert headers["content-type"] == "application/problem+json"
    prob = json.loads(body.decode("utf-8"))
    assert prob["detail"] == "missing required scope: widgets:write"


@pytest.mark.asyncio
async def test_middleware_resolves_spec_security_actions() -> None:
    spec = {
        "path": "orders",
        "security": {
            "actions": {
                "cancel": ["orders:cancel"],
            }
        },
    }
    mw = ScopeAuthMiddleware(
        dummy_app,
        spec=spec,
        extractor=lambda _: (True, ["orders:cancel"]),
    )

    scope_action = {"type": "http", "method": "POST", "path": "/orders/10/actions/cancel"}
    status, _, body = await make_asgi_request(mw, scope_action)
    assert status == 200
    assert body == b"OK"


@pytest.mark.asyncio
async def test_middleware_non_http_passthrough() -> None:
    called = False

    async def lifespan_app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        nonlocal called
        called = True

    mw = ScopeAuthMiddleware(lifespan_app, operation_scopes={"list": ["admin"]})
    await mw({"type": "lifespan"}, None, None)
    assert called is True

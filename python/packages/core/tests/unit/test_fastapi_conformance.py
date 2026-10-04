"""Regression suite: behaviours contracts/rules/rest-conventions.md requires of every
route adapter (Node express, Python fastapi, Go net/http + gin)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from server_decorator.adapters.fastapi import mount_fastapi_routes, validate_dto
from server_decorator.middleware.auth import enforce_scope_auth

SECURED_SPEC: dict[str, Any] = {
    "specVersion": "1.2.0",
    "entity": "Member",
    "path": "/members",
    "ops": ["list", "get", "create", "update", "delete"],
    "fields": [
        {"name": "id", "type": "str", "role": "id", "readonly": True},
        {"name": "name", "type": "str"},
    ],
    "actions": [{"name": "ping"}, {"name": "promote"}],
    "security": {
        "schemes": [{"name": "bearerAuth", "type": "http", "scheme": "bearer"}],
        "ops": {
            "list": [],
            "create": ["members:write"],
            "update": ["members:write"],
            "delete": ["members:delete"],
        },
        "actions": {"ping": [], "promote": ["members:admin"]},
    },
}


class _Handler:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def list(self, **_: Any) -> dict[str, Any]:
        self.calls.append("list")
        return {"items": [], "total": 0}

    async def get(self, id: str) -> Any:
        self.calls.append("get")
        return {"id": id, "name": "n"}

    async def create(self, data: dict[str, Any]) -> Any:
        self.calls.append("create")
        return {"id": "1", **data}

    async def update(self, id: str, data: dict[str, Any]) -> Any:
        self.calls.append("update")
        return {"id": id, **data}

    async def delete(self, id: str) -> None:
        self.calls.append("delete")

    async def action(self, id: str, action: str, data: dict[str, Any]) -> Any:
        self.calls.append(f"action:{action}")
        return {"ok": True}


def _client(handler: _Handler, **mount_kwargs: Any) -> httpx.AsyncClient:
    app = FastAPI()
    router = APIRouter()
    mount_fastapi_routes(router, SECURED_SPEC, handler, **mount_kwargs)
    app.include_router(router)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_empty_scope_list_requires_authentication() -> None:
    handler = _Handler()
    async with _client(handler, auth_extractor=lambda _req: (False, [])) as client:
        assert (await client.get("/members")).status_code == 401
        assert (await client.post("/members/m1/actions/ping", json={})).status_code == 401
        # no security entry -> public
        assert (await client.get("/members/m1")).status_code == 200
    assert handler.calls == ["get"]


async def test_empty_scope_list_allows_authenticated_without_scopes() -> None:
    handler = _Handler()
    async with _client(handler, auth_extractor=lambda _req: (True, [])) as client:
        assert (await client.get("/members")).status_code == 200


async def test_declared_security_fails_closed_without_extractor() -> None:
    handler = _Handler()
    async with _client(handler) as client:
        responses = [
            await client.get("/members"),
            await client.post("/members", json={"name": "x"}),
            await client.patch("/members/m1", json={"name": "x"}),
            await client.delete("/members/m1"),
            await client.post("/members/m1/actions/promote", json={}),
            await client.post("/members/m1/actions/ping", json={}),
        ]
        for res in responses:
            assert res.status_code == 401, res.request.url
            assert res.headers["content-type"] == "application/problem+json"
            assert res.json()["detail"] == "authentication required"
        # no security entry -> public
        assert (await client.get("/members/m1")).status_code == 200
    assert handler.calls == ["get"]


async def test_enforce_scope_auth_without_extractor_is_401() -> None:
    prob = await enforce_scope_auth(["items:read"], None, {"path": "/items/1"})
    assert prob is not None
    assert prob.status == 401
    assert prob.instance == "/items/1"


NESTED_SPEC: dict[str, Any] = {
    "specVersion": "1.2.0",
    "entity": "Account",
    "path": "/accounts",
    "ops": ["create", "update", "get"],
    "fields": [
        {"name": "id", "type": "str", "role": "id", "readonly": True},
        {
            "name": "profile",
            "type": "obj",
            "fields": [
                {"name": "bio", "type": "str"},
                {"name": "verifiedAt", "type": "datetime", "readonly": True},
                {"name": "secret", "type": "str", "writeonly": True},
            ],
        },
        {
            "name": "tags",
            "type": "list",
            "optional": True,
            "item": {
                "name": "item",
                "type": "obj",
                "fields": [
                    {"name": "label", "type": "str"},
                    {"name": "createdAt", "type": "datetime", "readonly": True},
                ],
            },
        },
    ],
}

_TS = "2026-01-01T00:00:00Z"
_PROFILE = {"bio": "x", "secret": "s"}


@pytest.mark.parametrize("dto", ["create", "update"])
def test_nested_readonly_not_required_and_not_accepted(dto: str) -> None:
    assert validate_dto(NESTED_SPEC, dto, {"profile": _PROFILE}) == ([], True)
    assert validate_dto(NESTED_SPEC, dto, {"profile": {**_PROFILE, "verifiedAt": _TS}}) == (
        ["profile.verifiedAt"],
        False,
    )


def test_nested_readonly_filtered_inside_list_items() -> None:
    assert validate_dto(NESTED_SPEC, "create", {"profile": _PROFILE, "tags": [{"label": "a"}]}) == (
        [],
        True,
    )
    assert validate_dto(
        NESTED_SPEC, "create", {"profile": _PROFILE, "tags": [{"label": "a", "createdAt": _TS}]}
    ) == (["tags.0.createdAt"], False)


def test_read_excludes_nested_writeonly_and_keeps_nested_readonly() -> None:
    read_profile = {"bio": "x", "verifiedAt": _TS}
    assert validate_dto(NESTED_SPEC, "read", {"id": "1", "profile": read_profile}) == ([], True)
    assert validate_dto(
        NESTED_SPEC, "read", {"id": "1", "profile": {**read_profile, "secret": "s"}}
    ) == (["profile.secret"], False)


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("hello", True),
        ("hello!", False),
        ("héllo", True),
        ("กข", False),
        ("กขฃ", True),
        ("\U0001f600" * 5, True),
        ("\U0001f600" * 6, False),
        ("\U0001f600" * 2, False),
    ],
)
def test_str_min_max_count_code_points(value: str, valid: bool) -> None:
    spec = {"fields": [{"name": "name", "type": "str", "min": 3, "max": 5}]}
    assert validate_dto(spec, "create", {"name": value})[1] is valid

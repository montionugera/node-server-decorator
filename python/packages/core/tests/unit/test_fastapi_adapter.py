"""Unit tests for FastAPI native router adapter."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from server_decorator.adapters.fastapi import (
    NotFoundError,
    mount_fastapi_routes,
    validate_dto,
)


def test_validate_dto():
    spec = {
        "specVersion": "1.2.0",
        "entity": "User",
        "path": "/users",
        "ops": ["list", "get", "create", "update", "delete"],
        "fields": [
            {"name": "id", "type": "str", "role": "id", "readonly": True},
            {"name": "email", "type": "str", "format": "email"},
            {"name": "age", "type": "int", "min": 0, "max": 150},
            {"name": "score", "type": "float", "optional": True},
            {"name": "active", "type": "bool"},
            {"name": "role", "type": "enum", "enum": ["admin", "member"]},
            {"name": "created_at", "type": "datetime", "readonly": True},
            {"name": "bio", "type": "str", "optional": True, "nullable": True},
        ],
        "actions": [
            {
                "name": "promote",
                "input": [
                    {"name": "new_role", "type": "enum", "enum": ["admin", "superadmin"]},
                    {"name": "reason", "type": "str", "min": 3},
                ],
            }
        ],
    }

    # 1. Valid create payload
    valid_create = {
        "email": "alex@example.com",
        "age": 30,
        "active": True,
        "role": "member",
    }
    errs, ok = validate_dto(spec, "create", valid_create)
    assert ok is True
    assert errs == []

    # 2. Unknown field in strict mode
    bad_unknown = {**valid_create, "extra_field": "bad"}
    errs, ok = validate_dto(spec, "create", bad_unknown)
    assert ok is False
    assert "extra_field" in errs

    # 3. Missing required fields
    missing_fields = {"email": "alex@example.com"}
    errs, ok = validate_dto(spec, "create", missing_fields)
    assert ok is False
    assert "active" in errs
    assert "age" in errs
    assert "role" in errs

    # 4. Email validation (WHATWG parity)
    errs, ok = validate_dto(spec, "create", {**valid_create, "email": "a@b.c"})
    assert ok is True
    errs, ok = validate_dto(spec, "create", {**valid_create, "email": "a@"})
    assert ok is False
    assert "email" in errs

    # 5. Update payload with optional fields
    errs, ok = validate_dto(spec, "update", {"email": "updated@example.com"})
    assert ok is True

    # 6. Action validation
    valid_action = {"new_role": "admin", "reason": "Outstanding impact"}
    errs, ok = validate_dto(spec, "action:promote", valid_action)
    assert ok is True

    invalid_action = {"new_role": "guest", "reason": "hi"}
    errs, ok = validate_dto(spec, "action:promote", invalid_action)
    assert ok is False
    assert "new_role" in errs
    assert "reason" in errs


class MockUserHandler:
    def __init__(self):
        self.db: list[dict[str, Any]] = [
            {"id": "1", "name": "Alice", "email": "alice@example.com", "status": "active"},
            {"id": "2", "name": "Bob", "email": "bob@example.com", "status": "pending"},
        ]

    async def list(
        self, limit: int, offset: int, filters: dict[str, str]
    ) -> tuple[list[dict[str, Any]], int]:
        filtered = list(self.db)
        if "status" in filters:
            filtered = [u for u in filtered if u.get("status") == filters["status"]]
        items = filtered[offset : offset + limit]
        return items, len(filtered)

    async def get(self, id: str) -> dict[str, Any]:
        user = next((u for u in self.db if u["id"] == id), None)
        if user is None:
            raise NotFoundError(f"User {id} not found")
        return user

    async def create(self, data: dict[str, Any]) -> dict[str, Any]:
        new_user = {"id": str(len(self.db) + 1), **data}
        self.db.append(new_user)
        return new_user

    async def update(self, id: str, data: dict[str, Any]) -> dict[str, Any]:
        user = next((u for u in self.db if u["id"] == id), None)
        if user is None:
            raise NotFoundError(f"User {id} not found")
        user.update(data)
        return user

    async def delete(self, id: str) -> None:
        user = next((u for u in self.db if u["id"] == id), None)
        if user is None:
            raise NotFoundError(f"User {id} not found")
        self.db.remove(user)

    async def action(self, id: str, action_name: str, data: dict[str, Any]) -> dict[str, Any]:
        user = next((u for u in self.db if u["id"] == id), None)
        if user is None:
            raise NotFoundError(f"User {id} not found")
        if action_name == "deactivate":
            user["status"] = "inactive"
            user["deactivated_reason"] = data.get("reason")
            return user
        raise ValueError(f"Unknown action {action_name}")


@pytest.fixture
def user_spec():
    return {
        "specVersion": "1.2.0",
        "entity": "User",
        "path": "users",
        "ops": ["list", "get", "create", "update", "delete"],
        "fields": [
            {"name": "id", "type": "str", "role": "id", "readonly": True},
            {"name": "name", "type": "str", "min": 2},
            {"name": "email", "type": "str", "format": "email"},
            {"name": "status", "type": "str", "filterable": True, "optional": True},
        ],
        "actions": [
            {
                "name": "deactivate",
                "input": [{"name": "reason", "type": "str", "min": 1}],
            }
        ],
        "security": {
            "ops": {
                "list": ["users:read"],
                "get": ["users:read"],
                "create": ["users:write"],
                "update": ["users:write"],
                "delete": ["users:admin"],
            },
            "actions": {
                "deactivate": ["users:admin"],
            },
        },
    }


@pytest.mark.asyncio
async def test_fastapi_adapter_crud(user_spec):
    handler = MockUserHandler()
    app = FastAPI()
    router = APIRouter()

    # Scope auth extractor allowing everything
    async def auth_extractor(req):
        return True, ["users:read", "users:write", "users:admin"]

    mount_fastapi_routes(router, user_spec, handler, auth_extractor=auth_extractor)
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. GET /users (list)
        res = await client.get("/users")
        assert res.status_code == 200
        data = res.json()
        assert data["limit"] == 20
        assert data["offset"] == 0
        assert data["total"] == 2
        assert len(data["items"]) == 2

        # 2. GET /users with filterable param
        res = await client.get("/users?status=pending")
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 1
        assert data["items"][0]["status"] == "pending"

        # 3. GET /users/{id}
        res = await client.get("/users/1")
        assert res.status_code == 200
        assert res.json()["name"] == "Alice"

        # 4. GET /users/{id} Not Found -> 404 Problem Details
        res = await client.get("/users/999")
        assert res.status_code == 404
        assert res.headers["content-type"] == "application/problem+json"
        prob = res.json()
        assert prob["title"] == "Not Found"
        assert prob["status"] == 404
        assert "User 999 not found" in prob["detail"]

        # 5. POST /users (create) valid
        res = await client.post(
            "/users",
            json={"name": "Charlie", "email": "charlie@example.com"},
        )
        assert res.status_code == 201
        assert res.json()["id"] == "3"

        # 6. POST /users (create) invalid -> 400 Validation Problem
        res = await client.post(
            "/users",
            json={"name": "C", "email": "invalid-email"},
        )
        assert res.status_code == 400
        assert res.headers["content-type"] == "application/problem+json"
        prob = res.json()
        assert prob["type"] == "https://server-decorator.dev/errors/validation"
        assert "email" in prob["fields"]
        assert "name" in prob["fields"]

        # 7. PATCH /users/{id} (update) valid
        res = await client.patch("/users/1", json={"name": "Alice Cooper"})
        assert res.status_code == 200
        assert res.json()["name"] == "Alice Cooper"

        # 8. DELETE /users/{id}
        res = await client.delete("/users/1")
        assert res.status_code == 204

        # Verify deletion
        res = await client.get("/users/1")
        assert res.status_code == 404

        # 9. POST /users/{id}/actions/{action_name}
        res = await client.post(
            "/users/2/actions/deactivate",
            json={"reason": "Security violation"},
        )
        assert res.status_code == 200
        assert res.json()["status"] == "inactive"
        assert res.json()["deactivated_reason"] == "Security violation"


@pytest.mark.asyncio
async def test_fastapi_adapter_scope_auth(user_spec):
    handler = MockUserHandler()
    app = FastAPI()
    router = APIRouter()

    # User only has users:read
    current_auth = {"authenticated": True, "scopes": ["users:read"]}

    async def auth_extractor(req):
        return current_auth["authenticated"], current_auth["scopes"]

    mount_fastapi_routes(router, user_spec, handler, auth_extractor=auth_extractor)
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # GET /users is allowed with users:read
        res = await client.get("/users")
        assert res.status_code == 200

        # DELETE /users/1 requires users:admin -> 403 Forbidden
        res = await client.delete("/users/1")
        assert res.status_code == 403
        assert res.headers["content-type"] == "application/problem+json"
        prob = res.json()
        assert prob["status"] == 403
        assert "missing required scope: users:admin" in prob["detail"]

        # Unauthenticated -> 401 Unauthorized
        current_auth["authenticated"] = False
        res = await client.get("/users")
        assert res.status_code == 401
        assert res.headers["content-type"] == "application/problem+json"
        prob = res.json()
        assert prob["status"] == 401
        assert prob["detail"] == "authentication required"


@pytest.mark.asyncio
async def test_fastapi_adapter_custom_id():
    custom_spec = {
        "specVersion": "1.2.0",
        "entity": "Device",
        "path": "devices",
        "ops": ["get"],
        "fields": [
            {"name": "device_id", "type": "str", "role": "id", "readonly": True},
            {"name": "hostname", "type": "str"},
        ],
    }

    class DeviceHandler:
        async def get(self, id: str):
            return {"device_id": id, "hostname": "edge-node-1"}

    app = FastAPI()
    router = APIRouter()
    mount_fastapi_routes(router, custom_spec, DeviceHandler())
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/devices/dev-99")
        assert res.status_code == 200
        assert res.json() == {"device_id": "dev-99", "hostname": "edge-node-1"}

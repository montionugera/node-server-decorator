"""Declarative scope-based authorization middleware and RFC 9457 Problem Details."""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass
class ProblemDetails:
    """RFC 9457 Problem Details object."""

    type: str = "about:blank"
    title: str = ""
    status: int = 500
    detail: str | None = None
    instance: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return Problem Details dictionary omitting None fields."""
        res: dict[str, Any] = {
            "type": self.type,
            "title": self.title,
            "status": self.status,
        }
        if self.detail is not None:
            res["detail"] = self.detail
        if self.instance is not None:
            res["instance"] = self.instance
        return res


def check_scopes(required: Sequence[str], held: Sequence[str]) -> tuple[bool, str | None]:
    """Check if every scope in required is present in held.

    Returns (True, None) if all are satisfied, or (False, first_missing_scope).
    """
    held_set = set(held)
    for req in required:
        if req not in held_set:
            return False, req
    return True, None


ScopeExtractor = Callable[[Any], Awaitable[tuple[bool, list[str]]] | tuple[bool, list[str]]]


async def enforce_scope_auth(
    required_scopes: Sequence[str],
    extractor: ScopeExtractor | None,
    request: Any,
) -> ProblemDetails | None:
    """Helper function to enforce scope authorization on a request.

    Returns None if authorized; returns ProblemDetails (401 or 403) on failure.
    """
    auth_result: Any
    if extractor is None:
        # Fail closed: declared security with no extractor never exposes the route.
        auth_result = (False, [])
    else:
        try:
            res = extractor(request)
            if inspect.isawaitable(res):
                auth_result = await res
            else:
                auth_result = res
        except Exception:
            auth_result = (False, [])

    if isinstance(auth_result, tuple):
        authenticated = bool(auth_result[0])
        held_scopes = auth_result[1] if len(auth_result) > 1 else []
    elif isinstance(auth_result, dict):
        authenticated = bool(auth_result.get("authenticated", False))
        held_scopes = auth_result.get("scopes", [])
    elif hasattr(auth_result, "authenticated"):
        authenticated = bool(auth_result.authenticated)
        held_scopes = getattr(auth_result, "scopes", [])
    else:
        authenticated = False
        held_scopes = []

    instance: str | None = None
    if isinstance(request, dict):
        instance = request.get("path")
    elif hasattr(request, "url"):
        instance = str(request.url)
    elif hasattr(request, "path"):
        instance = str(request.path)

    if not authenticated:
        return ProblemDetails(
            type="about:blank",
            title="Unauthorized",
            status=401,
            detail="authentication required",
            instance=instance,
        )

    if required_scopes:
        ok, missing = check_scopes(required_scopes, held_scopes)
        if not ok:
            return ProblemDetails(
                type="about:blank",
                title="Forbidden",
                status=403,
                detail=f"missing required scope: {missing}",
                instance=instance,
            )

    return None


class ScopeAuthMiddleware:
    """ASGI-compliant middleware enforcing declarative scope-based authorization."""

    def __init__(
        self,
        app: Any,
        spec: Any = None,
        extractor: ScopeExtractor | None = None,
        operation_scopes: dict[str, list[str]] | None = None,
        action_scopes: dict[str, list[str]] | None = None,
    ) -> None:
        self.app = app
        self.spec = spec
        self.extractor = extractor
        self.operation_scopes = operation_scopes or {}
        self.action_scopes = action_scopes or {}

    def _resolve_required_scopes(self, scope: dict[str, Any]) -> list[str] | None:
        if "required_scopes" in scope:
            return scope["required_scopes"]  # type: ignore[no-any-return]

        spec_dict: dict[str, Any] | None = None
        if self.spec is not None:
            if hasattr(self.spec, "__entity_spec__"):
                spec_dict = self.spec.__entity_spec__
            elif isinstance(self.spec, dict):
                spec_dict = self.spec

        sec = spec_dict.get("security") if spec_dict else getattr(self.spec, "security", None)
        spec_ops: dict[str, list[str]] = {}
        spec_actions: dict[str, list[str]] = {}
        if sec:
            if isinstance(sec, dict):
                spec_ops = sec.get("ops", {}) or {}
                spec_actions = sec.get("actions", {}) or {}
            else:
                spec_ops = getattr(sec, "ops", {}) or {}
                spec_actions = getattr(sec, "actions", {}) or {}

        if "operation" in scope:
            op = scope["operation"]
            if op in self.operation_scopes:
                return self.operation_scopes[op]
            if op in spec_ops:
                return spec_ops[op]
            return None

        if "action" in scope:
            act = scope["action"]
            if act in self.action_scopes:
                return self.action_scopes[act]
            if act in spec_actions:
                return spec_actions[act]
            return None

        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()

        if f"{method} {path}" in self.operation_scopes:
            return self.operation_scopes[f"{method} {path}"]
        if path in self.operation_scopes:
            return self.operation_scopes[path]

        base_path = ""
        if spec_dict and "path" in spec_dict:
            base_path = "/" + str(spec_dict["path"]).strip("/")
        elif self.spec and hasattr(self.spec, "path"):
            base_path = "/" + str(self.spec.path).strip("/")

        if base_path:
            norm_path = "/" + path.strip("/")
            resolved_op: str | None = None
            resolved_act: str | None = None

            if norm_path == base_path:
                if method == "GET":
                    resolved_op = "list"
                elif method == "POST":
                    resolved_op = "create"
            elif norm_path.startswith(base_path + "/"):
                sub = norm_path[len(base_path) + 1 :].split("/")
                if len(sub) == 1:
                    if method == "GET":
                        resolved_op = "get"
                    elif method in ("PUT", "PATCH"):
                        resolved_op = "update"
                    elif method == "DELETE":
                        resolved_op = "delete"
                elif len(sub) == 3 and sub[1] == "actions":
                    resolved_act = sub[2]
                elif len(sub) == 2 and sub[0] == "actions":
                    resolved_act = sub[1]

            if resolved_op:
                if resolved_op in self.operation_scopes:
                    return self.operation_scopes[resolved_op]
                if resolved_op in spec_ops:
                    return spec_ops[resolved_op]
                if spec_dict and "ops" in spec_dict and resolved_op in spec_dict["ops"]:
                    return None

            if resolved_act:
                if resolved_act in self.action_scopes:
                    return self.action_scopes[resolved_act]
                if resolved_act in spec_actions:
                    return spec_actions[resolved_act]
                return None

        return None

    async def _send_problem(self, send: Any, problem: ProblemDetails) -> None:
        body = json.dumps(problem.to_dict()).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": problem.status,
                "headers": [
                    (b"content-type", b"application/problem+json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": body,
            }
        )

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        required = self._resolve_required_scopes(scope)
        if required is None:
            # Public endpoint
            await self.app(scope, receive, send)
            return

        if self.extractor is None:
            await self._send_problem(
                send,
                ProblemDetails(
                    type="about:blank",
                    title="Unauthorized",
                    status=401,
                    detail="authentication required",
                    instance=scope.get("path"),
                ),
            )
            return

        try:
            res = self.extractor(scope)
            if inspect.isawaitable(res):
                auth_result = await res
            else:
                auth_result = res
        except Exception:
            auth_result = (False, [])

        if isinstance(auth_result, tuple):
            authenticated = bool(auth_result[0])
            held_scopes = auth_result[1] if len(auth_result) > 1 else []
        elif isinstance(auth_result, dict):
            authenticated = bool(auth_result.get("authenticated", False))
            held_scopes = auth_result.get("scopes", [])
        elif hasattr(auth_result, "authenticated"):
            authenticated = bool(auth_result.authenticated)
            held_scopes = getattr(auth_result, "scopes", [])
        else:
            authenticated = False
            held_scopes = []

        if not authenticated:
            await self._send_problem(
                send,
                ProblemDetails(
                    type="about:blank",
                    title="Unauthorized",
                    status=401,
                    detail="authentication required",
                    instance=scope.get("path"),
                ),
            )
            return

        if len(required) > 0:
            ok, missing = check_scopes(required, held_scopes)
            if not ok:
                await self._send_problem(
                    send,
                    ProblemDetails(
                        type="about:blank",
                        title="Forbidden",
                        status=403,
                        detail=f"missing required scope: {missing}",
                        instance=scope.get("path"),
                    ),
                )
                return

        await self.app(scope, receive, send)

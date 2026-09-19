"""FastAPI native router adapter for EntitySpec IR."""

from __future__ import annotations

import datetime
import inspect
import re
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, cast, runtime_checkable

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from server_decorator.middleware.auth import ScopeExtractor, enforce_scope_auth

PROBLEM_CONTENT_TYPE = "application/problem+json"
VALIDATION_PROBLEM_TYPE = "https://server-decorator.dev/errors/validation"

EMAIL_PATTERN = (
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9]"
    r"(?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
URI_PATTERN = r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+$"

_EMAIL_RE = re.compile(EMAIL_PATTERN)
_UUID_RE = re.compile(UUID_PATTERN)
_URI_RE = re.compile(URI_PATTERN)


class NotFoundError(Exception):
    """Exception raised when an entity or resource is not found."""

    status_code: int = 404

    def __init__(self, message: str = "Not Found") -> None:
        super().__init__(message)
        self.message = message


class ProblemDetailsResponse(JSONResponse):
    """RFC 9457 Problem Details HTTP response."""

    media_type = PROBLEM_CONTENT_TYPE


def problem_response(
    status: int,
    title: str | None = None,
    detail: str | None = None,
    instance: str | None = None,
) -> ProblemDetailsResponse:
    """Create an RFC 9457 Problem Details response."""
    default_titles = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        500: "Internal Server Error",
    }
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": title or default_titles.get(status, "Error"),
        "status": status,
    }
    if detail is not None:
        body["detail"] = detail
    if instance is not None:
        body["instance"] = instance
    return ProblemDetailsResponse(status_code=status, content=body)


def validation_problem_response(
    fields: list[str],
    instance: str | None = None,
) -> ProblemDetailsResponse:
    """Create an RFC 9457 Validation Problem Details response with status 400."""
    body: dict[str, Any] = {
        "type": VALIDATION_PROBLEM_TYPE,
        "title": "Validation Failed",
        "status": 400,
        "fields": fields or [],
    }
    if instance is not None:
        body["instance"] = instance
    return ProblemDetailsResponse(status_code=400, content=body)


@runtime_checkable
class EntityHandler(Protocol):
    """Protocol for entity operations handling."""

    async def list(
        self, limit: int, offset: int, filters: dict[str, str]
    ) -> tuple[list[Any], int] | dict[str, Any]: ...
    async def get(self, id: str) -> Any: ...
    async def create(self, data: dict[str, Any]) -> Any: ...
    async def update(self, id: str, data: dict[str, Any]) -> Any: ...
    async def delete(self, id: str) -> None: ...
    async def action(self, id: str, action: str, data: dict[str, Any]) -> Any: ...


def _has_explicit_utc_offset(s: str) -> bool:
    if s.endswith("Z") or s.endswith("z"):
        return True
    if len(s) >= 6:
        tail = s[-6:]
        if tail[0] in ("+", "-") and tail[3] == ":":
            return True
    return False


def _join_path(parent: str, field: str) -> str:
    return field if parent == "" else f"{parent}.{field}"


def validate_dto(
    spec: dict[str, Any],
    dto_type: str,
    payload: Any,
) -> tuple[list[str], bool]:
    """Validate a JSON payload against the given EntitySpec and DTO type."""
    fields = spec.get("fields", [])

    if dto_type == "create":
        target_fields = [f for f in fields if not f.get("readonly")]
    elif dto_type == "update":
        target_fields = [{**f, "optional": True} for f in fields if not f.get("readonly")]
    elif dto_type == "read":
        target_fields = [f for f in fields if not f.get("writeonly")]
    elif dto_type.startswith("action:"):
        action_name = dto_type[len("action:") :]
        actions = spec.get("actions", [])
        found = next((a for a in actions if a.get("name") == action_name), None)
        if found is None:
            return ["_action"], False
        target_fields = found.get("input", [])
    else:
        return ["_dto"], False

    err_map: set[str] = set()
    _validate_object(target_fields, payload, "", err_map)

    if not err_map:
        return [], True

    return sorted(err_map), False


def _validate_object(
    fields: list[dict[str, Any]],
    payload: Any,
    current_path: str,
    err_map: set[str],
) -> None:
    if not isinstance(payload, dict):
        if current_path != "":
            err_map.add(current_path)
        else:
            err_map.add("_root")
        return

    field_by_name = {f["name"]: f for f in fields if "name" in f}

    # 1. Check for unrecognized keys (strict object)
    for k in payload:
        if k not in field_by_name:
            err_map.add(_join_path(current_path, k))

    # 2. Validate declared fields
    for f in fields:
        name = f["name"]
        f_path = _join_path(current_path, name)
        if name not in payload:
            if not f.get("optional"):
                err_map.add(f_path)
            continue

        val = payload[name]
        if val is None:
            if not f.get("nullable"):
                err_map.add(f_path)
            continue

        _validate_field_value(f, val, f_path, err_map)


def _validate_field_value(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    f_type = f.get("type")
    if f_type in ("str", "ref"):
        _validate_string(f, val, path, err_map)
    elif f_type == "int":
        _validate_int(f, val, path, err_map)
    elif f_type == "float":
        _validate_float(f, val, path, err_map)
    elif f_type == "bool":
        _validate_bool(val, path, err_map)
    elif f_type == "datetime":
        _validate_datetime(val, path, err_map)
    elif f_type == "enum":
        _validate_enum(f, val, path, err_map)
    elif f_type == "list":
        _validate_list(f, val, path, err_map)
    elif f_type == "obj":
        _validate_object(f.get("fields", []), val, path, err_map)
    else:
        err_map.add(path)


def _validate_string(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    if not isinstance(val, str):
        err_map.add(path)
        return

    min_len = f.get("min")
    if min_len is not None and len(val) < min_len:
        err_map.add(path)
        return

    max_len = f.get("max")
    if max_len is not None and len(val) > max_len:
        err_map.add(path)
        return

    fmt = f.get("format")
    if fmt == "email":
        if not _EMAIL_RE.match(val):
            err_map.add(path)
            return
    elif fmt == "uuid":
        if not _UUID_RE.match(val):
            err_map.add(path)
            return
    elif fmt == "uri":
        if not _URI_RE.match(val):
            err_map.add(path)
            return
    elif f.get("pattern"):
        pattern = f["pattern"]
        try:
            if not re.search(pattern, val):
                err_map.add(path)
                return
        except Exception:
            err_map.add(path)
            return


def _validate_int(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    if isinstance(val, bool):
        err_map.add(path)
        return

    int_val: int
    if isinstance(val, int):
        int_val = val
    elif isinstance(val, float) and val.is_integer():
        int_val = int(val)
    else:
        err_map.add(path)
        return

    min_val = f.get("min")
    if min_val is not None and int_val < min_val:
        err_map.add(path)
    max_val = f.get("max")
    if max_val is not None and int_val > max_val:
        err_map.add(path)


def _validate_float(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        err_map.add(path)
        return

    fl_val = float(val)
    min_val = f.get("min")
    if min_val is not None and fl_val < min_val:
        err_map.add(path)
    max_val = f.get("max")
    if max_val is not None and fl_val > max_val:
        err_map.add(path)


def _validate_bool(val: Any, path: str, err_map: set[str]) -> None:
    if not isinstance(val, bool):
        err_map.add(path)


def _validate_datetime(val: Any, path: str, err_map: set[str]) -> None:
    if not isinstance(val, str):
        err_map.add(path)
        return

    if not _has_explicit_utc_offset(val):
        err_map.add(path)
        return

    try:
        # datetime.fromisoformat handles standard ISO 8601 strings
        iso_str = val.replace("Z", "+00:00").replace("z", "+00:00")
        datetime.datetime.fromisoformat(iso_str)
    except Exception:
        err_map.add(path)


def _validate_enum(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    if not isinstance(val, str):
        err_map.add(path)
        return

    allowed = f.get("enum", [])
    if val not in allowed:
        err_map.add(path)


def _validate_list(
    f: dict[str, Any],
    val: Any,
    path: str,
    err_map: set[str],
) -> None:
    if not isinstance(val, list):
        err_map.add(path)
        return

    item_spec = f.get("item")
    if item_spec:
        for idx, elem in enumerate(val):
            _validate_field_value(item_spec, elem, f"{path}.{idx}", err_map)


def resolve_entity_spec(spec_or_class: Any) -> dict[str, Any]:
    """Resolve an EntitySpec dict from either a dict or a decorated class."""
    if spec_or_class is None:
        raise ValueError("spec_or_class is required")

    if isinstance(spec_or_class, dict):
        return spec_or_class

    if isinstance(spec_or_class, type):
        if hasattr(spec_or_class, "__entity_spec__"):
            return cast(dict[str, Any], spec_or_class.__entity_spec__)
        if hasattr(spec_or_class, "entity_spec"):
            spec_attr = spec_or_class.entity_spec
            res = spec_attr() if callable(spec_attr) else spec_attr
            return cast(dict[str, Any], res)

        try:
            from server_decorator_entity import entity_spec  # type: ignore[import-not-found]

            return cast(dict[str, Any], entity_spec(spec_or_class))
        except Exception:
            pass

    raise TypeError(f"Unable to resolve EntitySpec from {spec_or_class!r}")


async def _invoke_handler(func: Any, *args: Any, **kwargs: Any) -> Any:
    res = func(*args, **kwargs)
    if inspect.isawaitable(res):
        return await res
    return res


def mount_fastapi_routes(
    router: Any,
    spec_or_class: Any,
    handler: Any,
    auth_extractor: ScopeExtractor | None = None,
) -> Any:
    """Mount standard CRUD and Action endpoints for the given EntitySpec on a FastAPI APIRouter."""
    spec = resolve_entity_spec(spec_or_class)

    id_field = "id"
    for f in spec.get("fields", []):
        if f.get("role") == "id":
            id_field = f.get("name", "id")
            break

    clean_path = spec.get("path", "").strip("/")
    base_path = f"/{clean_path}"
    item_path = f"{base_path}/{{{id_field}}}"

    filterable_fields = {f["name"] for f in spec.get("fields", []) if f.get("filterable")}
    security = spec.get("security", {})
    ops_security = security.get("ops", {})
    actions_security = security.get("actions", {})

    def make_list_endpoint(scopes: list[str] | None) -> Callable[[Request], Awaitable[Response]]:
        async def list_endpoint(request: Request) -> Response:
            if scopes is not None and auth_extractor is not None:
                problem = await enforce_scope_auth(scopes, auth_extractor, request)
                if problem is not None:
                    return ProblemDetailsResponse(
                        status_code=problem.status, content=problem.to_dict()
                    )

            limit = 20
            if "limit" in request.query_params:
                try:
                    parsed = int(request.query_params["limit"])
                    if parsed >= 0:
                        limit = 100 if parsed > 100 else parsed
                except ValueError:
                    pass

            offset = 0
            if "offset" in request.query_params:
                try:
                    parsed = int(request.query_params["offset"])
                    if parsed >= 0:
                        offset = parsed
                except ValueError:
                    pass

            filters = {
                k: request.query_params[k] for k in filterable_fields if k in request.query_params
            }

            try:
                result = await _invoke_handler(
                    handler.list, limit=limit, offset=offset, filters=filters
                )
                if isinstance(result, tuple):
                    items, total = result
                elif isinstance(result, dict):
                    items = result.get("items", [])
                    total = result.get("total", len(items))
                else:
                    items = []
                    total = 0

                return JSONResponse(
                    status_code=200,
                    content={
                        "items": items,
                        "total": total,
                        "limit": limit,
                        "offset": offset,
                    },
                )
            except Exception as e:
                return problem_response(500, detail=str(e), instance=str(request.url.path))

        return list_endpoint

    def make_get_endpoint(scopes: list[str] | None) -> Callable[[Request], Awaitable[Response]]:
        async def get_endpoint(request: Request) -> Response:
            ident = request.path_params.get(id_field, "")
            if scopes is not None and auth_extractor is not None:
                problem = await enforce_scope_auth(scopes, auth_extractor, request)
                if problem is not None:
                    return ProblemDetailsResponse(
                        status_code=problem.status, content=problem.to_dict()
                    )

            try:
                result = await _invoke_handler(handler.get, ident)
                if result is None:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=f"entity with id {ident} not found",
                        instance=str(request.url.path),
                    )
                return JSONResponse(status_code=200, content=result)
            except NotFoundError as e:
                return problem_response(
                    404,
                    title="Not Found",
                    detail=str(e) or f"entity with id {ident} not found",
                    instance=str(request.url.path),
                )
            except Exception as e:
                if getattr(e, "status_code", None) == 404:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=str(e),
                        instance=str(request.url.path),
                    )
                return problem_response(500, detail=str(e), instance=str(request.url.path))

        return get_endpoint

    def make_create_endpoint(
        scopes: list[str] | None,
    ) -> Callable[[Request], Awaitable[Response]]:
        async def create_endpoint(request: Request) -> Response:
            if scopes is not None and auth_extractor is not None:
                problem = await enforce_scope_auth(scopes, auth_extractor, request)
                if problem is not None:
                    return ProblemDetailsResponse(
                        status_code=problem.status, content=problem.to_dict()
                    )

            try:
                body = await request.json()
            except Exception:
                return validation_problem_response(["_body"], instance=str(request.url.path))

            err_fields, ok = validate_dto(spec, "create", body)
            if not ok:
                return validation_problem_response(err_fields, instance=str(request.url.path))

            try:
                result = await _invoke_handler(handler.create, body)
                return JSONResponse(status_code=201, content=result)
            except Exception as e:
                return problem_response(500, detail=str(e), instance=str(request.url.path))

        return create_endpoint

    def make_update_endpoint(
        scopes: list[str] | None,
    ) -> Callable[[Request], Awaitable[Response]]:
        async def update_endpoint(request: Request) -> Response:
            ident = request.path_params.get(id_field, "")
            if scopes is not None and auth_extractor is not None:
                problem = await enforce_scope_auth(scopes, auth_extractor, request)
                if problem is not None:
                    return ProblemDetailsResponse(
                        status_code=problem.status, content=problem.to_dict()
                    )

            try:
                body = await request.json()
            except Exception:
                return validation_problem_response(["_body"], instance=str(request.url.path))

            err_fields, ok = validate_dto(spec, "update", body)
            if not ok:
                return validation_problem_response(err_fields, instance=str(request.url.path))

            try:
                result = await _invoke_handler(handler.update, ident, body)
                if result is None:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=f"entity with id {ident} not found",
                        instance=str(request.url.path),
                    )
                return JSONResponse(status_code=200, content=result)
            except NotFoundError as e:
                return problem_response(
                    404,
                    title="Not Found",
                    detail=str(e) or f"entity with id {ident} not found",
                    instance=str(request.url.path),
                )
            except Exception as e:
                if getattr(e, "status_code", None) == 404:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=str(e),
                        instance=str(request.url.path),
                    )
                return problem_response(500, detail=str(e), instance=str(request.url.path))

        return update_endpoint

    def make_delete_endpoint(
        scopes: list[str] | None,
    ) -> Callable[[Request], Awaitable[Response]]:
        async def delete_endpoint(request: Request) -> Response:
            ident = request.path_params.get(id_field, "")
            if scopes is not None and auth_extractor is not None:
                problem = await enforce_scope_auth(scopes, auth_extractor, request)
                if problem is not None:
                    return ProblemDetailsResponse(
                        status_code=problem.status, content=problem.to_dict()
                    )

            try:
                await _invoke_handler(handler.delete, ident)
                return Response(status_code=204)
            except NotFoundError as e:
                return problem_response(
                    404,
                    title="Not Found",
                    detail=str(e) or f"entity with id {ident} not found",
                    instance=str(request.url.path),
                )
            except Exception as e:
                if getattr(e, "status_code", None) == 404:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=str(e),
                        instance=str(request.url.path),
                    )
                return problem_response(500, detail=str(e), instance=str(request.url.path))

        return delete_endpoint

    for op in spec.get("ops", []):
        required_scopes = ops_security.get(op) if ops_security else None

        if op == "list":
            router.add_api_route(
                base_path,
                make_list_endpoint(required_scopes),
                methods=["GET"],
                response_class=JSONResponse,
            )
        elif op == "get":
            router.add_api_route(
                item_path,
                make_get_endpoint(required_scopes),
                methods=["GET"],
                response_class=JSONResponse,
            )
        elif op == "create":
            router.add_api_route(
                base_path,
                make_create_endpoint(required_scopes),
                methods=["POST"],
                response_class=JSONResponse,
            )
        elif op == "update":
            router.add_api_route(
                item_path,
                make_update_endpoint(required_scopes),
                methods=["PATCH"],
                response_class=JSONResponse,
            )
        elif op == "delete":
            router.add_api_route(
                item_path,
                make_delete_endpoint(required_scopes),
                methods=["DELETE"],
            )

    for act in spec.get("actions", []):
        action_name = act.get("name", "")
        action_route = f"{item_path}/actions/{action_name}"
        action_scopes = actions_security.get(action_name) if actions_security else None
        has_input = bool(act.get("input"))

        # We need to capture action_name and action_scopes in closure
        def make_action_endpoint(
            act_name: str, scopes: list[str] | None, requires_input: bool
        ) -> Callable[[Request], Awaitable[Response]]:
            async def action_endpoint(request: Request) -> Response:
                ident = request.path_params.get(id_field, "")
                if scopes is not None and auth_extractor is not None:
                    problem = await enforce_scope_auth(scopes, auth_extractor, request)
                    if problem is not None:
                        return ProblemDetailsResponse(
                            status_code=problem.status, content=problem.to_dict()
                        )

                body: dict[str, Any] = {}
                if requires_input:
                    try:
                        body = await request.json()
                    except Exception:
                        return validation_problem_response(
                            ["_body"], instance=str(request.url.path)
                        )

                    err_fields, ok = validate_dto(spec, f"action:{act_name}", body)
                    if not ok:
                        return validation_problem_response(
                            err_fields, instance=str(request.url.path)
                        )
                else:
                    try:
                        body = await request.json()
                    except Exception:
                        body = {}

                try:
                    result = await _invoke_handler(handler.action, ident, act_name, body)
                    return JSONResponse(status_code=200, content=result)
                except NotFoundError as e:
                    return problem_response(
                        404,
                        title="Not Found",
                        detail=str(e) or f"entity with id {ident} not found",
                        instance=str(request.url.path),
                    )
                except Exception as e:
                    if getattr(e, "status_code", None) == 404:
                        return problem_response(
                            404,
                            title="Not Found",
                            detail=str(e),
                            instance=str(request.url.path),
                        )
                    return problem_response(500, detail=str(e), instance=str(request.url.path))

            return action_endpoint

        router.add_api_route(
            action_route,
            make_action_endpoint(action_name, action_scopes, has_input),
            methods=["POST"],
            response_class=JSONResponse,
        )

    return router

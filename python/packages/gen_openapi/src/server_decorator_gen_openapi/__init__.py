"""IR-derived OpenAPI 3.1 document — see contracts/rules/rest-conventions.md."""

from collections.abc import Callable
from typing import Any

# Copied from contracts/rules/entity-spec-validation.md, not imported: this package must
# not depend on gen_pydantic (layering rule). Keep byte-identical to gen-openapi's patterns.ts.
EMAIL_PATTERN = (
    r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?"
    r"(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
URI_PATTERN = r"^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$"

_BASE_TYPE = {
    "str": "string",
    "ref": "string",
    "int": "integer",
    "float": "number",
    "bool": "boolean",
    "datetime": "string",
    "enum": "string",
    "list": "array",
    "obj": "object",
}
_FORMAT_PATTERN = {"email": EMAIL_PATTERN, "uuid": UUID_PATTERN, "uri": URI_PATTERN}

Include = Callable[[dict[str, Any]], bool]


def json_schema_for_field(f: dict[str, Any], include: Include | None = None) -> dict[str, Any]:
    """Map one IR field to JSON Schema.

    ``include`` threads through EVERY level of nesting — obj members and list items alike —
    because contracts/rules/rest-conventions.md filters nested obj and list members by the same
    rule as their parent, and gen_pydantic's model builder already does exactly this. Without it
    a create DTO would keep a readonly member that lives inside a list of objects.
    """
    keep: Include = (lambda _f: True) if include is None else include
    t = f["type"]
    base = _BASE_TYPE[t]
    s: dict[str, Any] = {"type": [base, "null"] if f.get("nullable") else base}
    if t == "datetime":
        s["format"] = "date-time"
    if t in ("str", "ref"):
        fmt = f.get("format")
        if fmt:
            s["format"] = fmt
            s["pattern"] = _FORMAT_PATTERN[fmt]
        if "pattern" in f:
            s["pattern"] = f["pattern"]
        if "min" in f:
            s["minLength"] = f["min"]
        if "max" in f:
            s["maxLength"] = f["max"]
    if t in ("int", "float"):
        if "min" in f:
            s["minimum"] = f["min"]
        if "max" in f:
            s["maximum"] = f["max"]
    if t == "enum":
        s["enum"] = list(f["enum"])
    if t == "list":
        s["items"] = json_schema_for_field(f["item"], keep) if f.get("item") else {}
        if "min" in f:
            s["minItems"] = f["min"]
        if "max" in f:
            s["maxItems"] = f["max"]
    if t == "obj":
        kept = [n for n in f.get("fields", []) if keep(n)]
        s["properties"] = object_properties(kept, keep)
        # Filter `required` by `include` too: an excluded member left in `required` would make
        # the schema impossible to satisfy, since its property is not emitted at all.
        required = [n["name"] for n in kept if not n.get("optional")]
        if required:
            s["required"] = required
        s["additionalProperties"] = False
    if "description" in f:
        s["description"] = f["description"]
    return s


def object_properties(fields: list[dict[str, Any]], include: Include) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in [x for x in fields if include(x)]:
        out[f["name"]] = json_schema_for_field(f, include)
    return out


def _strict_object(fields: list[dict[str, Any]], include: Include) -> dict[str, Any]:
    kept = [f for f in fields if include(f)]
    s: dict[str, Any] = {"type": "object", "properties": object_properties(kept, include)}
    required = [f["name"] for f in kept if not f.get("optional")]
    if required:
        s["required"] = required
    s["additionalProperties"] = False
    return s


def _list_envelope(entity: str, pagination: str) -> dict[str, Any]:
    items = {"type": "array", "items": {"$ref": f"#/components/schemas/{entity}Read"}}
    limit = {"type": "integer", "minimum": 1, "maximum": 100}
    if pagination == "cursor":
        return {
            "type": "object",
            "properties": {"items": items, "nextCursor": {"type": ["string", "null"]}},
            "required": ["items", "nextCursor"],
            "additionalProperties": False,
        }
    return {
        "type": "object",
        "properties": {
            "items": items,
            "total": {"type": "integer", "minimum": 0},
            "limit": limit,
            "offset": {"type": "integer", "minimum": 0},
        },
        "required": ["items", "total", "limit", "offset"],
        "additionalProperties": False,
    }


_PROBLEM_PROPS: dict[str, Any] = {
    "type": {"type": "string", "format": "uri"},
    "title": {"type": "string"},
    "status": {"type": "integer"},
    "detail": {"type": "string"},
    "instance": {"type": "string", "format": "uri"},
}

PROBLEM_SCHEMAS: dict[str, Any] = {
    "Problem": {
        "type": "object",
        "properties": dict(_PROBLEM_PROPS),
        "required": ["type", "title", "status"],
        "additionalProperties": False,
    },
    "ValidationProblem": {
        "type": "object",
        "properties": {**_PROBLEM_PROPS, "fields": {"type": "array", "items": {"type": "string"}}},
        "required": ["type", "title", "status", "fields"],
        "additionalProperties": False,
    },
}


def _scheme_object(s: dict[str, Any]) -> dict[str, Any]:
    if s["type"] == "apiKey":
        return {"type": "apiKey", "in": s["in"], "name": s["paramName"]}
    out: dict[str, Any] = {"type": "http", "scheme": s["scheme"]}
    if "bearerFormat" in s:
        out["bearerFormat"] = s["bearerFormat"]
    return out


def openapi_components(spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    e = spec["entity"]
    create = _strict_object(spec["fields"], lambda f: not f.get("readonly"))
    update = {k: v for k, v in create.items() if k != "required"}
    schemas: dict[str, Any] = {
        f"{e}Create": create,
        f"{e}Update": update,
        f"{e}Read": _strict_object(spec["fields"], lambda f: not f.get("writeonly")),
        f"{e}ListResponse": _list_envelope(e, spec["pagination"]),
    }
    for a in spec.get("actions", []):
        name = a["name"][0].upper() + a["name"][1:]
        schemas[f"{e}{name}Input"] = _strict_object(a.get("input", []), lambda _f: True)
    security_schemes = {
        s["name"]: _scheme_object(s) for s in spec.get("security", {}).get("schemes", [])
    }
    return schemas, security_schemes


def _problem(status: str, description: str, component: str = "Problem") -> dict[str, Any]:
    return {
        status: {
            "description": description,
            "content": {
                "application/problem+json": {
                    "schema": {"$ref": f"#/components/schemas/{component}"}
                }
            },
        }
    }


def _json(ref: str) -> dict[str, Any]:
    return {"content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{ref}"}}}}


def _security_for(spec: dict[str, Any], key: str, kind: str) -> dict[str, Any]:
    security = spec.get("security")
    if security is None or key not in security.get(kind, {}):
        return {}
    schemes = security.get("schemes", [])
    if not schemes:
        return {}
    return {"security": [{schemes[0]["name"]: security[kind][key]}]}


def _filter_params(spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for f in spec["fields"]:
        if not f.get("filterable"):
            continue
        bare = {k: v for k, v in f.items() if k not in ("optional", "nullable")}
        out.append(
            {
                "name": f["name"],
                "in": "query",
                "required": False,
                "schema": json_schema_for_field(bare),
            }
        )
    return out


def _pagination_params(spec: dict[str, Any]) -> list[dict[str, Any]]:
    limit = {
        "name": "limit",
        "in": "query",
        "required": False,
        "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
    }
    if spec["pagination"] == "cursor":
        return [
            limit,
            {"name": "cursor", "in": "query", "required": False, "schema": {"type": "string"}},
        ]
    return [
        limit,
        {
            "name": "offset",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "minimum": 0, "default": 0},
        },
    ]


def openapi_paths(spec: dict[str, Any]) -> dict[str, Any]:
    e = spec["entity"]
    base = "/" + spec["path"]
    id_field = next((f for f in spec["fields"] if f.get("role") == "id"), None)
    if id_field is None:
        raise ValueError(f'{e}: no field with role "id"')
    id_bare = {k: v for k, v in id_field.items() if k != "role"}
    id_param = {
        "name": id_field["name"],
        "in": "path",
        "required": True,
        "schema": json_schema_for_field(id_bare),
    }
    tags = {"tags": spec["tags"]} if "tags" in spec else {}
    ops = spec["ops"]
    out: dict[str, Any] = {}
    collection: dict[str, Any] = {}
    item: dict[str, Any] = {}
    filters = _filter_params(spec)

    if "list" in ops:
        params = sorted(_pagination_params(spec) + filters, key=lambda p: str(p["name"]))
        responses = {"200": {"description": "OK", **_json(f"{e}ListResponse")}}
        if filters:
            responses.update(_problem("400", "Bad Request", "ValidationProblem"))
        collection["get"] = {
            **tags,
            "operationId": f"list{e}",
            "parameters": params,
            "responses": responses,
            **_security_for(spec, "list", "ops"),
        }
    if "create" in ops:
        collection["post"] = {
            **tags,
            "operationId": f"create{e}",
            "requestBody": {"required": True, **_json(f"{e}Create")},
            "responses": {
                "201": {"description": "Created", **_json(f"{e}Read")},
                **_problem("400", "Bad Request", "ValidationProblem"),
            },
            **_security_for(spec, "create", "ops"),
        }
    if "get" in ops:
        item["get"] = {
            **tags,
            "operationId": f"get{e}",
            "parameters": [id_param],
            "responses": {
                "200": {"description": "OK", **_json(f"{e}Read")},
                **_problem("404", "Not Found"),
            },
            **_security_for(spec, "get", "ops"),
        }
    if "update" in ops:
        item["patch"] = {
            **tags,
            "operationId": f"update{e}",
            "parameters": [id_param],
            "requestBody": {"required": True, **_json(f"{e}Update")},
            "responses": {
                "200": {"description": "OK", **_json(f"{e}Read")},
                **_problem("400", "Bad Request", "ValidationProblem"),
                **_problem("404", "Not Found"),
            },
            **_security_for(spec, "update", "ops"),
        }
    if "delete" in ops:
        item["delete"] = {
            **tags,
            "operationId": f"delete{e}",
            "parameters": [id_param],
            "responses": {
                "204": {"description": "No Content"},
                **_problem("404", "Not Found"),
            },
            **_security_for(spec, "delete", "ops"),
        }
    if collection:
        out[base] = collection
    if item:
        out[f"{base}/{{{id_field['name']}}}"] = item

    for a in spec.get("actions", []):
        name = a["name"][0].upper() + a["name"][1:]
        responses = {
            "200": {"description": "OK", **_json(f"{e}Read")},
            **_problem("400", "Bad Request", "ValidationProblem"),
            **_problem("404", "Not Found"),
        }
        if "from" in a:
            responses.update(_problem("409", "Conflict"))
        post: dict[str, Any] = {
            **tags,
            "operationId": f"{a['name']}{e}",
            "parameters": [id_param],
        }
        if "description" in a:
            post["description"] = a["description"]
        post["requestBody"] = {"required": True, **_json(f"{e}{name}Input")}
        post["responses"] = responses
        post.update(_security_for(spec, a["name"], "actions"))
        out[f"{base}/{{{id_field['name']}}}/actions/{a['name']}"] = {"post": post}
    return out


def openapi_document(specs: list[dict[str, Any]], version: str) -> dict[str, Any]:
    schemas: dict[str, Any] = dict(PROBLEM_SCHEMAS)
    security_schemes: dict[str, Any] = {}
    paths: dict[str, Any] = {}
    tag_names: set[str] = set()

    for spec in specs:
        s, sec = openapi_components(spec)
        schemas.update(s)
        security_schemes.update(sec)
        paths.update(openapi_paths(spec))
        tag_names.update(spec.get("tags", []))

    doc: dict[str, Any] = {
        "openapi": "3.1.0",
        "info": {"title": "server-decorator API", "version": version},
        "paths": paths,
        "components": {"schemas": schemas},
    }
    if tag_names:
        doc["tags"] = [{"name": n} for n in sorted(tag_names)]
    if security_schemes:
        doc["components"]["securitySchemes"] = security_schemes
    return doc

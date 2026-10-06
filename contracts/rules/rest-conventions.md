# REST conventions

Normative for every generator and adapter built on the EntitySpec IR. Contract version 1.3.0.

## Route mapping

`path` carries no leading slash (`^[a-z][a-z0-9-]*$`); the route is `/` + `path`.
The id path parameter is named after the field with `role: "id"`.

| op | Method + path | Success | Request body | Response body |
| --- | --- | --- | --- | --- |
| `list` | `GET /{path}` | 200 | none | `{Entity}ListResponse` |
| `get` | `GET /{path}/{id}` | 200 | none | `{Entity}Read` |
| `create` | `POST /{path}` | 201 | `{Entity}Create` | `{Entity}Read` |
| `update` | `PATCH /{path}/{id}` | 200 | `{Entity}Update` | `{Entity}Read` |
| `delete` | `DELETE /{path}/{id}` | 204 | none | none |
| action | `POST /{path}/{id}/actions/{name}` | 200 | `{Entity}{Action}Input` | `{Entity}Read` |

`update` is PATCH, never PUT: `{Entity}Update` is an all-optional schema, so PATCH is the
semantically honest verb. An entity whose `ops` omits an entry emits no route for it.

## Component naming

| Component | Derivation | Contents |
| --- | --- | --- |
| `{Entity}Create` | fields where `readonly` is absent | required = non-optional members |
| `{Entity}Update` | `{Entity}Create` with every property optional | `required` omitted |
| `{Entity}Read` | fields where `writeonly` is absent | required = non-optional members |
| `{Entity}{Action}Input` | the action's `input` fields; `{Action}` is the action name capitalised | `{}` with `additionalProperties: false` when the action has no input |
| `{Entity}ListResponse` | pagination envelope | see below |
| `Problem` | RFC 9457 | shared by all entities, emitted once |
| `ValidationProblem` | `Problem` plus `fields` | shared by all entities, emitted once |

Nested `obj` and `list` members are filtered recursively by the same include rule as their
parent. Every object schema sets `additionalProperties: false`.

## Field to JSON Schema mapping

| IR type | JSON Schema |
| --- | --- |
| `str`, `ref` | `{"type": "string"}` |
| `int` | `{"type": "integer"}` |
| `float` | `{"type": "number"}` |
| `bool` | `{"type": "boolean"}` |
| `datetime` | `{"type": "string", "format": "date-time"}` |
| `enum` | `{"type": "string", "enum": [...]}` |
| `list` | `{"type": "array", "items": <item>}` |
| `obj` | `{"type": "object", "properties": {...}, "additionalProperties": false}` |

- `format` `email`/`uuid`/`uri` emit the matching OpenAPI `format` **and** the `pattern`
  constant from `contracts/rules/entity-spec-validation.md`, so validators that ignore
  `format` still agree.
- `min`/`max` emit `minLength`/`maxLength` on `str` and `ref`, `minimum`/`maximum` on
  `int` and `float`, `minItems`/`maxItems` on `list`.
  Route adapters that validate request bodies (Node express, Python fastapi, Go `dto`) count
  `str`/`ref` length in **Unicode code points**, matching JSON Schema `minLength`/`maxLength` —
  never bytes or UTF-16 code units (`"héllo"` is 5; five emoji are 5). They also apply the
  recursive include rule from "Component naming" to nested `obj`/`list` members: a nested
  `readonly` member is neither required nor accepted on create/update.
- `nullable` emits an OpenAPI 3.1 type array: `{"type": ["string", "null"]}`.
- `optional` removes the member from `required`; it never changes the member schema.
- `description` emits `description`. Absent means the key is omitted, never `""`.

## Pagination

`pagination: "offset"` — query `limit` (integer, default 20, maximum 100) and `offset`
(integer, minimum 0, default 0). Envelope:

```json
{"items": [], "total": 0, "limit": 20, "offset": 0}
```

`pagination: "cursor"` — query `limit` (same bounds) and `cursor` (string, optional).
Envelope:

```json
{"items": [], "nextCursor": null}
```

`items` is always `{"type": "array", "items": {"$ref": "#/components/schemas/{Entity}Read"}}`.
`nextCursor` is `{"type": ["string", "null"]}`.

## Filtering

Every field with `filterable: true` becomes an optional query parameter on `list` only.
Its schema is the field's own mapping with `optional`/`nullable` stripped. Enum fields carry
their `enum` list. Nested fields are never filterable — only top-level ones.

## Errors

Every non-2xx response is `application/problem+json` (RFC 9457).

| Status | Component | When |
| --- | --- | --- |
| 400 | `ValidationProblem` | body or query fails DTO validation |
| 401 | `Problem` | operation declares scopes, credentials absent or invalid |
| 403 | `Problem` | authenticated, declared scopes not held |
| 404 | `Problem` | id not found |
| 409 | `Problem` | action invoked from a state its `from` does not permit |

`Problem` properties: `type` (string, uri), `title` (string), `status` (integer),
`detail` (string), `instance` (string, uri). `required`: `type`, `title`, `status`.
`ValidationProblem` adds `fields`: `{"type": "array", "items": {"type": "string"}}`, the
sorted field-path list `validationErrorFields()` produces. `additionalProperties: false` on both.

Which statuses appear on which operation:

- 400 on `create`, `update`, actions, and on `list` when the entity has filterable fields.
- 404 on `get`, `update`, `delete`, actions.
- 409 on actions declaring `from`.
- 401 and 403 only on operations carrying a `security` requirement.

## Security

`security.schemes` emits `components.securitySchemes` keyed by each scheme's `name`.
`security.ops[op]` and `security.actions[name]` emit the operation's `security` array as
`[{<schemeName>: [<scopes>]}]`, referencing the **first** declared scheme. An operation with
no entry emits no `security` key and is public. An entry of `[]` emits
`[{<schemeName>: []}]` — authentication required, no particular scope.

Route adapters enforce this at mount time and **fail closed**: an operation or action with an
entry (including `[]`) answers `401` when the caller is unauthenticated, when the scope
extractor errors, **and when no scope extractor was supplied to the adapter at all**. A
declared requirement is never silently unenforced. A service that authenticates upstream of
the adapter opts out explicitly by supplying an extractor that reports the request as
authenticated with the scopes it holds.

Scope strings are opaque: no hierarchy, no wildcards, no implied containment. Use permission
strings (`user:write`), never role names, never ownership relationships. Object-level
authorization is out of scope permanently — see the design doc's non-goals.

## SSE replay (`Last-Event-ID`)

Event IDs are opaque strings: broadcasters never compare or order them. Replay on reconnect is
**positional** in the history buffer. If the presented `Last-Event-ID` is in the buffer, the
events after its position are replayed in order. If it is not (or no longer) in the buffer,
the **whole buffer** is replayed in order — a client may then see events it already has, but
never silently misses one. Registering the subscriber and taking the replay snapshot happen
atomically, so an event is delivered exactly once (replayed or live), and live events are
never filtered by ID after a replay.

## Document assembly

`openapi: "3.1.0"`. `info.title` is `"server-decorator API"`, `info.version` mirrors
`contracts/VERSION`. Entities contribute `tags` entries deduplicated and sorted by name.
Paths are emitted sorted by path string; every object's keys are sorted by the canonicalizer.
A list operation's `parameters` array is sorted by parameter `name` in **code-point order**
(`userName` before `userid`) — never a locale-aware comparison such as JS `localeCompare`, whose
result depends on the host's ICU data.

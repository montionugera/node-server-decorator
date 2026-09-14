# REST OpenAPI Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a byte-identical OpenAPI 3.1 document from the EntitySpec IR in both Node and Python, and extend the IR with the description, tag and scope metadata a usable API description requires.

**Architecture:** Two new pure-function packages (`node/packages/gen-openapi`, `python/packages/gen_openapi`) sit beside the existing DTO generators as peers, consuming only their own language's `entity` package. The EntitySpec IR gains optional `description`/`tags`/`security` fields, `contracts/VERSION` moves to 1.2.0, and a new `contracts/rules/rest-conventions.md` pins the URL, pagination and error conventions that both generators — and every future HTTP adapter — must honour. Cross-language agreement is enforced by a golden document plus a parity script, exactly as the entity layer already does.

**Tech Stack:** TypeScript 5.9 + Jest + pnpm 9.14.2 workspace (Node); Python 3 + pytest + ruff + mypy strict + uv workspace (Python); JSON Schema 2020-12 + ajv-cli for contracts.

**Spec:** `docs/superpowers/specs/2026-08-15-rest-openapi-generator-design.md`

## Global Constraints

- `contracts/VERSION`, `node/packages/core/src/_contract.ts` and `python/packages/core/src/server_decorator/_contract.py` must all read exactly `1.2.0` by the end of Task 5. `ci-contracts.yml` fails otherwise.
- Every IR addition is **optional**. Every fixture that passed under 1.1.0 must still pass unchanged.
- `gen-openapi` / `gen_openapi` may import **only** their own language's `entity` package. Never `core`, never the other language, never the sibling `gen-*` package.
- Byte-identical output is produced by the **existing** canonicalizers — `canonicalJson` (Node, exported from `@montionugera/entity-spec`) and `canonical_json` (Python, `server_decorator_entity.canonical`). Do not write new canonicalization logic.
- Scope strings in fixtures and examples are **permission-shaped** (`user:write`), never role names (`superadmin`), never relationships (`owner`).
- No HTTP framework may appear in any dependency list. These packages are pure functions.
- Security scheme `type` is a closed enum: `http` | `apiKey`. Nothing else validates.
- `update` maps to **PATCH**. There is no PUT route.
- Node commands run from `node/`; Python from `python/`. Python uses `uv run`.
- Version lockstep: all eight packages carry one version. Use `scripts/bump-version.sh`, never `pnpm version`.

---

### Task 1: Fix clean-checkout build order and add an exports map

`pnpm -r test:unit` currently fails on a fresh clone because `gen-zod` resolves `@montionugera/entity-spec` through `dist/`, which does not exist until a build runs. `gen-openapi` will import `entity` the same way, so this is fixed first.

**Files:**
- Modify: `node/packages/entity/package.json`
- Modify: `node/packages/gen-zod/package.json`
- Modify: `node/packages/gen-zod/src/gen-zod.spec.ts:4`
- Modify: `CLAUDE.md` (the "Common commands" table)

**Interfaces:**
- Consumes: nothing.
- Produces: `@montionugera/entity-spec/testing` as the supported import path for `UserFixture`. Every later task uses that path, never `.../dist/testing/user-fixture`.

- [ ] **Step 1: Reproduce the failure on a clean tree**

```bash
cd node && rm -rf packages/*/dist && pnpm -r test:unit
```

Expected: FAIL in `packages/gen-zod` with `TS2307: Cannot find module '@montionugera/entity-spec'`.

- [ ] **Step 2: Add an exports map to the entity package**

In `node/packages/entity/package.json`, add alongside the existing `main`/`types` keys (keep both for older resolvers):

```json
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./testing": {
      "types": "./dist/testing/user-fixture.d.ts",
      "default": "./dist/testing/user-fixture.js"
    }
  },
```

- [ ] **Step 3: Replace the deep dist import**

In `node/packages/gen-zod/src/gen-zod.spec.ts` line 4, change:

```ts
import { UserFixture } from '@montionugera/entity-spec/dist/testing/user-fixture';
```

to:

```ts
import { UserFixture } from '@montionugera/entity-spec/testing';
```

- [ ] **Step 4: Make the unit lane build its dependency first**

In `node/packages/gen-zod/package.json`, add to `scripts`:

```json
    "pretest:unit": "pnpm --filter @montionugera/entity-spec run build",
```

- [ ] **Step 5: Verify from a clean tree**

```bash
cd node && rm -rf packages/*/dist && pnpm -r test:unit
```

Expected: PASS — all three packages green, with no manual build step.

- [ ] **Step 6: Correct the command table in CLAUDE.md**

In the "Common commands" table, change the `gen-zod tests` row to note the automatic dependency build:

```markdown
| gen-zod tests | `cd node/packages/gen-zod && pnpm test:unit` (builds `entity` first via `pretest:unit`; schemas checked against `contracts/fixtures/entity-spec.cases.json`) |
```

- [ ] **Step 7: Commit**

```bash
git add node/packages/entity/package.json node/packages/gen-zod/package.json \
        node/packages/gen-zod/src/gen-zod.spec.ts CLAUDE.md
git commit -m "fix(node): build entity before gen-zod tests, add exports map"
```

---

### Task 2: Write the REST conventions rule document

Pure contract text. Every generator and every future adapter is bound by it, so it lands before any generator code.

**Files:**
- Create: `contracts/rules/rest-conventions.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the normative conventions Tasks 6-9 implement. Component naming (`{Entity}Create`, `{Entity}Update`, `{Entity}Read`, `{Entity}{Action}Input`, `{Entity}ListResponse`, `Problem`, `ValidationProblem`) is defined here and used verbatim by both generators.

- [ ] **Step 1: Write the document**

Create `contracts/rules/rest-conventions.md` with this content:

````markdown
# REST conventions

Normative for every generator and adapter built on the EntitySpec IR. Contract version 1.2.0.

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

Scope strings are opaque: no hierarchy, no wildcards, no implied containment. Use permission
strings (`user:write`), never role names, never ownership relationships. Object-level
authorization is out of scope permanently — see the design doc's non-goals.

## Document assembly

`openapi: "3.1.0"`. `info.title` is `"server-decorator API"`, `info.version` mirrors
`contracts/VERSION`. Entities contribute `tags` entries deduplicated and sorted by name.
Paths are emitted sorted by path string; every object's keys are sorted by the canonicalizer.
````

- [ ] **Step 2: Verify the contract lane is still green**

```bash
bash contracts/scripts/validate.sh
```

Expected: PASS — the doc adds no schema, so all fixtures still validate.

- [ ] **Step 3: Commit**

```bash
git add contracts/rules/rest-conventions.md
git commit -m "docs(contracts): add REST conventions rule document"
```

---

### Task 3: Node entity accepts description, tags and security

New options only — `specVersion` stays `1.1.0` until Task 5, so the tree stays green.

**Files:**
- Modify: `node/packages/entity/src/types.ts`
- Modify: `node/packages/entity/src/fields.ts:24-26`
- Modify: `node/packages/entity/src/restful.ts:6-11,29-52`
- Modify: `node/packages/entity/src/action.ts`
- Modify: `node/packages/entity/src/validate.ts:120-131`
- Test: `node/packages/entity/src/restful.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SecuritySpec`, `SecurityScheme` types and the `description`/`tags`/`security` members of `EntitySpec`, `FieldSpec`, `ActionSpec`. Task 4 mirrors these names in Python; Tasks 6-8 read them.

- [ ] **Step 1: Write the failing test**

Append to `node/packages/entity/src/restful.spec.ts`:

```ts
describe('1.2.0 metadata', () => {
  it('carries description, tags and security into the spec', () => {
    @Restful({
      path: 'widgets',
      description: 'A widget',
      tags: ['catalog'],
      security: {
        schemes: [{ name: 'bearerAuth', type: 'http', scheme: 'bearer' }],
        ops: { create: ['widget:write'] },
      },
    })
    class Widget {
      @id() id!: string;
      @str({ description: 'Display name' }) name!: string;
    }

    const spec = entitySpec(Widget);
    expect(spec.description).toBe('A widget');
    expect(spec.tags).toEqual(['catalog']);
    expect(spec.security?.ops?.create).toEqual(['widget:write']);
    expect(spec.fields[1].description).toBe('Display name');
  });

  it('rejects a security op the entity does not expose', () => {
    expect(() => {
      @Restful({
        path: 'widgets',
        ops: ['list'],
        security: {
          schemes: [{ name: 'bearerAuth', type: 'http', scheme: 'bearer' }],
          ops: { create: ['widget:write'] },
        },
      })
      class Widget {
        @id() id!: string;
      }
      return Widget;
    }).toThrow(/security.ops.create.*not declared in ops/);
  });

  it('rejects an unknown scheme type', () => {
    expect(() => {
      @Restful({
        path: 'widgets',
        security: { schemes: [{ name: 'x', type: 'oauth2' } as never] },
      })
      class Widget {
        @id() id!: string;
      }
      return Widget;
    }).toThrow(/scheme "x": type must be "http" or "apiKey"/);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

```bash
cd node/packages/entity && pnpm test:unit -- --testPathPattern=restful.spec
```

Expected: FAIL — `description` is not a known property of `RestfulOpts`.

- [ ] **Step 3: Add the types**

In `node/packages/entity/src/types.ts`, add `description?: string;` to `FieldSpec` and to `ActionSpec`, then add:

```ts
export interface SecurityScheme {
  name: string;
  type: 'http' | 'apiKey';
  scheme?: 'bearer' | 'basic';
  bearerFormat?: string;
  in?: 'header' | 'query' | 'cookie';
  paramName?: string;
}

export interface SecuritySpec {
  schemes: SecurityScheme[];
  ops?: Record<string, string[]>;
  actions?: Record<string, string[]>;
}
```

and to `EntitySpec`:

```ts
  description?: string;
  tags?: string[];
  security?: SecuritySpec;
```

- [ ] **Step 4: Let field builders pass description through**

In `node/packages/entity/src/fields.ts`, extend the `Flags` alias so every typed helper accepts it:

```ts
type Flags = Pick<
  FieldSpec,
  'optional' | 'nullable' | 'readonly' | 'writeonly' | 'filterable' | 'description'
>;
```

- [ ] **Step 5: Accept the new options on @Restful and @action**

In `node/packages/entity/src/restful.ts`, extend `RestfulOpts`:

```ts
export interface RestfulOpts {
  path: string;
  transports?: Transport[];
  ops?: Op[];
  pagination?: 'offset' | 'cursor';
  description?: string;
  tags?: string[];
  security?: SecuritySpec;
}
```

and spread the optional members into the built spec, immediately after `pagination`, keeping
absent keys absent so the canonical JSON is unchanged for 1.1-era declarations:

```ts
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts.security !== undefined ? { security: opts.security } : {}),
```

In `node/packages/entity/src/action.ts`, add `description?: string` to `ActionOpts` and copy it
into the emitted action object only when defined.

- [ ] **Step 6: Validate the security block**

In `node/packages/entity/src/validate.ts`, add and call from `validateEntitySpec`:

```ts
export function validateSecurity(
  security: SecuritySpec | undefined,
  ops: unknown[],
  actionNames: string[],
  entity: string,
): void {
  if (!security) return;
  if (security.schemes.length === 0) {
    throw new Error(`${entity}: security.schemes must not be empty`);
  }
  for (const s of security.schemes) {
    if (s.type !== 'http' && s.type !== 'apiKey') {
      throw new Error(`${entity}: scheme "${s.name}": type must be "http" or "apiKey"`);
    }
    if (s.type === 'http' && s.scheme === undefined) {
      throw new Error(`${entity}: scheme "${s.name}": http requires "scheme"`);
    }
    if (s.type === 'apiKey' && (s.in === undefined || s.paramName === undefined)) {
      throw new Error(`${entity}: scheme "${s.name}": apiKey requires "in" and "paramName"`);
    }
  }
  for (const op of Object.keys(security.ops ?? {})) {
    if (!ops.includes(op)) {
      throw new Error(`${entity}: security.ops.${op} is not declared in ops`);
    }
  }
  for (const name of Object.keys(security.actions ?? {})) {
    if (!actionNames.includes(name)) {
      throw new Error(`${entity}: security.actions.${name} is not a declared action`);
    }
  }
}
```

Extend `ValidatableEntitySpec` with `security?: SecuritySpec` and call it at the end of
`validateEntitySpec`:

```ts
  validateSecurity(spec.security, spec.ops, (spec.actions ?? []).map((a) => a.name), spec.entity);
```

Export `validateSecurity` from `node/packages/entity/src/index.ts`.

- [ ] **Step 7: Run the tests**

```bash
cd node/packages/entity && pnpm test:unit
```

Expected: PASS — all previous tests plus the three new ones.

- [ ] **Step 8: Confirm nothing downstream broke**

```bash
cd node && pnpm -r test:unit && bash ../scripts/check-entity-parity.sh
```

Expected: PASS both — the additions are optional and the fixture has not changed yet.

- [ ] **Step 9: Commit**

```bash
git add node/packages/entity/src CLAUDE.md
git commit -m "feat(entity): accept description, tags and security options (Node)"
```

---

### Task 4: Python entity accepts description, tags and security

Mirrors Task 3 exactly. `specVersion` still `1.1.0`.

**Files:**
- Modify: `python/packages/entity/src/server_decorator_entity/markers.py:16-62`
- Modify: `python/packages/entity/src/server_decorator_entity/restful.py:25-92`
- Modify: `python/packages/entity/src/server_decorator_entity/action.py`
- Modify: `python/packages/entity/src/server_decorator_entity/validate.py`
- Test: `python/packages/entity/tests/test_restful.py`

**Interfaces:**
- Consumes: the option names fixed in Task 3 — `description`, `tags`, `security` with keys `schemes`, `ops`, `actions`; scheme keys `name`, `type`, `scheme`, `bearerFormat`, `in`, `paramName`.
- Produces: identical IR members, so Task 5's shared fixture matches byte for byte.

- [ ] **Step 1: Write the failing test**

Append to `python/packages/entity/tests/test_restful.py`:

```python
import pytest
from typing import Annotated
from server_decorator_entity import Id, Str, restful, entity_spec


def test_metadata_flows_into_spec() -> None:
    @restful(
        path="widgets",
        description="A widget",
        tags=["catalog"],
        security={
            "schemes": [{"name": "bearerAuth", "type": "http", "scheme": "bearer"}],
            "ops": {"create": ["widget:write"]},
        },
    )
    class Widget:
        id: Annotated[str, Id()]
        name: Annotated[str, Str(description="Display name")]

    spec = entity_spec(Widget)
    assert spec["description"] == "A widget"
    assert spec["tags"] == ["catalog"]
    assert spec["security"]["ops"]["create"] == ["widget:write"]
    assert spec["fields"][1]["description"] == "Display name"


def test_security_op_must_be_declared() -> None:
    with pytest.raises(ValueError, match=r"security\.ops\.create is not declared in ops"):

        @restful(
            path="widgets",
            ops=["list"],
            security={
                "schemes": [{"name": "bearerAuth", "type": "http", "scheme": "bearer"}],
                "ops": {"create": ["widget:write"]},
            },
        )
        class Widget:
            id: Annotated[str, Id()]


def test_unknown_scheme_type_rejected() -> None:
    with pytest.raises(ValueError, match=r'scheme "x": type must be "http" or "apiKey"'):

        @restful(path="widgets", security={"schemes": [{"name": "x", "type": "oauth2"}]})
        class Widget:
            id: Annotated[str, Id()]
```

- [ ] **Step 2: Run it to confirm failure**

```bash
cd python/packages/entity && uv run pytest tests/test_restful.py -q
```

Expected: FAIL — `restful() got an unexpected keyword argument 'description'`.

- [ ] **Step 3: Add description to FieldMarker**

In `markers.py`, add `description: str | None = None` to the `FieldMarker` dataclass, and in
`to_ir` emit it immediately after `pattern` so key insertion order matches Node's (the
canonicalizer sorts keys, but keeping the order aligned makes diffs readable):

```python
        if self.description is not None:
            ir["description"] = self.description
```

Add `description: str | None = None` to every field-builder function signature in `markers.py`
(`Str`, `Email`, `Uuid`, `Uri`, `Int`, `Float`, `Bool`, `Datetime`, `EnumOf`, `Ref`, `ListOf`,
`Obj`) and pass it through to the `FieldMarker` constructor.

- [ ] **Step 4: Add validation**

In `validate.py`:

```python
def assert_valid_security(
    security: dict[str, Any] | None,
    ops: list[str],
    action_names: list[str],
    entity: str,
) -> None:
    if security is None:
        return
    schemes = security.get("schemes", [])
    if not schemes:
        raise ValueError(f"{entity}: security.schemes must not be empty")
    for s in schemes:
        name = s.get("name")
        if s.get("type") not in ("http", "apiKey"):
            raise ValueError(f'{entity}: scheme "{name}": type must be "http" or "apiKey"')
        if s["type"] == "http" and "scheme" not in s:
            raise ValueError(f'{entity}: scheme "{name}": http requires "scheme"')
        if s["type"] == "apiKey" and ("in" not in s or "paramName" not in s):
            raise ValueError(f'{entity}: scheme "{name}": apiKey requires "in" and "paramName"')
    for op in security.get("ops", {}):
        if op not in ops:
            raise ValueError(f"{entity}: security.ops.{op} is not declared in ops")
    for action_name in security.get("actions", {}):
        if action_name not in action_names:
            raise ValueError(f"{entity}: security.actions.{action_name} is not a declared action")
```

- [ ] **Step 5: Accept the options on @restful and @action**

In `restful.py`, extend the signature:

```python
def restful(
    *,
    path: str,
    transports: list[str] | None = None,
    ops: list[str] | None = None,
    pagination: str = "offset",
    description: str | None = None,
    tags: list[str] | None = None,
    security: dict[str, Any] | None = None,
) -> Callable[[C], C]:
```

After `actions` is collected and before `setattr`, validate and attach:

```python
        assert_valid_security(
            security, resolved_ops, [a["name"] for a in actions], cls.__name__
        )
        if description is not None:
            spec["description"] = description
        if tags is not None:
            spec["tags"] = tags
        if security is not None:
            spec["security"] = security
```

In `action.py`, add a `description: str | None = None` keyword and emit it only when set.

- [ ] **Step 6: Run the checks**

```bash
cd python && bash scripts/check.sh
```

Expected: PASS — ruff, ruff format, mypy strict and pytest all green.

- [ ] **Step 7: Confirm parity still holds**

```bash
bash scripts/check-entity-parity.sh
```

Expected: PASS — the shared fixture is untouched so far.

- [ ] **Step 8: Commit**

```bash
git add python/packages/entity
git commit -m "feat(entity): accept description, tags and security options (Python)"
```

---

### Task 5: Bump the contract to 1.2.0 and extend the shared fixture

Atomic by necessity: the schema's `specVersion` const, both emitters, the version files and the golden fixture must move together or CI is red.

**Files:**
- Modify: `contracts/VERSION`
- Modify: `contracts/schemas/entity-spec.schema.json`
- Modify: `contracts/CHANGELOG.md`
- Modify: `node/packages/core/src/_contract.ts:5`
- Modify: `python/packages/core/src/server_decorator/_contract.py:3`
- Modify: `node/packages/entity/src/restful.ts` (`specVersion` literal)
- Modify: `node/packages/entity/src/types.ts` (`specVersion` type)
- Modify: `python/packages/entity/src/server_decorator_entity/restful.py:86`
- Modify: `node/packages/entity/src/testing/user-fixture.ts`
- Modify: `python/packages/entity/src/server_decorator_entity/testing/user_fixture.py`
- Modify: `contracts/fixtures/entity-spec.valid-user.json`

**Interfaces:**
- Consumes: the types and validation from Tasks 3 and 4.
- Produces: the 1.2.0 golden `UserFixture` that Task 10's OpenAPI golden document is generated from.

- [ ] **Step 1: Extend the JSON Schema**

In `contracts/schemas/entity-spec.schema.json`, change `$id` to `.../entity-spec/1.2.0.json`,
change `"specVersion": { "const": "1.1.0" }` to `{ "const": "1.2.0" }`, and add to the
top-level `properties`:

```json
    "description": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "security": { "$ref": "#/$defs/security" },
```

Add `"description": { "type": "string" }` to both `$defs/field/properties` and
`$defs/action/properties`, then add:

```json
    "security": {
      "type": "object",
      "required": ["schemes"],
      "additionalProperties": false,
      "properties": {
        "schemes": {
          "type": "array", "minItems": 1,
          "items": { "$ref": "#/$defs/securityScheme" }
        },
        "ops": {
          "type": "object",
          "additionalProperties": { "type": "array", "items": { "type": "string" } }
        },
        "actions": {
          "type": "object",
          "additionalProperties": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "securityScheme": {
      "type": "object",
      "required": ["name", "type"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-zA-Z][A-Za-z0-9]*$" },
        "type": { "enum": ["http", "apiKey"] },
        "scheme": { "enum": ["bearer", "basic"] },
        "bearerFormat": { "type": "string" },
        "in": { "enum": ["header", "query", "cookie"] },
        "paramName": { "type": "string" }
      }
    }
```

- [ ] **Step 2: Move the three version files**

```bash
echo "1.2.0" > contracts/VERSION
sed -i '' "s/'1.1.0' as const/'1.2.0' as const/" node/packages/core/src/_contract.ts
sed -i '' 's/CONTRACT_VERSION = "1.1.0"/CONTRACT_VERSION = "1.2.0"/' python/packages/core/src/server_decorator/_contract.py
```

- [ ] **Step 3: Move specVersion in both emitters**

In `node/packages/entity/src/types.ts` change `specVersion: '1.1.0';` to `specVersion: '1.2.0';`.
In `node/packages/entity/src/restful.ts` change the emitted literal to `'1.2.0'`.
In `python/.../restful.py` change `"specVersion": "1.1.0"` to `"specVersion": "1.2.0"`.

- [ ] **Step 4: Extend both UserFixtures identically**

In `node/packages/entity/src/testing/user-fixture.ts`, change the decorator to:

```ts
@Restful({
  path: 'users',
  transports: ['rest', 'rpc', 'sse', 'ws'],
  description: 'A registered user account',
  tags: ['identity'],
  security: {
    schemes: [{ name: 'bearerAuth', type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }],
    ops: { create: ['user:write'], update: ['user:write'], delete: ['user:admin'] },
    actions: { activate: ['user:admin'] },
  },
})
```

and add a description to exactly one field and one action:

```ts
  @email({ filterable: true, description: 'Primary contact address' }) email!: string;

  @action('activate', { from: 'inactive', to: 'active',
    description: 'Move a dormant account back to active',
    input: [{ name: 'reason', type: 'str', max: 200, optional: true }] })
  activate(): void {}
```

Apply the identical changes to `python/.../testing/user_fixture.py` using the Python spelling
(`description=`, `tags=`, `security=` on `@restful`; `description=` on `Email(...)` and
`@action`).

- [ ] **Step 5: Regenerate the golden fixture from the Node emitter**

```bash
cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts \
  > ../../../contracts/fixtures/entity-spec.valid-user.json
```

- [ ] **Step 6: Verify parity, contracts and both test suites**

```bash
bash scripts/check-entity-parity.sh
bash contracts/scripts/validate.sh
cd node && pnpm -r test:unit && cd ../python && bash scripts/check.sh
```

Expected: all PASS. If the DTO generators fail, the metadata is leaking into generated
schemas — they must ignore `description`, `tags` and `security` entirely at this stage.

- [ ] **Step 7: Record the change**

Add a `## 1.2.0` section to `contracts/CHANGELOG.md` listing: optional `description` on
entity, field and action; optional `tags` and `security` on entity; new
`rules/rest-conventions.md`; and a note that all additions are backward compatible for
readers, but `specVersion` now reads `1.2.0`.

- [ ] **Step 8: Commit**

```bash
git add contracts node/packages/core/src/_contract.ts node/packages/entity \
        python/packages/core/src/server_decorator/_contract.py python/packages/entity
git commit -m "feat(contracts): entity-spec 1.2.0 — descriptions, tags, security"
```

---

### Task 6: Scaffold Node gen-openapi with the field-to-JSON-Schema mapper

**Files:**
- Create: `node/packages/gen-openapi/package.json`
- Create: `node/packages/gen-openapi/tsconfig.json`
- Create: `node/packages/gen-openapi/jest.config.js`
- Create: `node/packages/gen-openapi/src/map-field.ts`
- Create: `node/packages/gen-openapi/src/index.ts`
- Test: `node/packages/gen-openapi/src/map-field.spec.ts`

**Interfaces:**
- Consumes: `FieldSpec` from `@montionugera/entity-spec`; the mapping table in `contracts/rules/rest-conventions.md`.
- Produces: `jsonSchemaForField(f: FieldSpec): JsonSchema` and `type JsonSchema = Record<string, unknown>`. Tasks 7 and 8 build every component from it.

- [ ] **Step 1: Copy the package scaffolding from gen-zod**

Create `node/packages/gen-openapi/package.json` mirroring `gen-zod`'s, with:

```json
{
  "name": "@montionugera/entity-spec-gen-openapi",
  "version": "2.0.4",
  "description": "IR-derived OpenAPI 3.1 document (contracts/rules/rest-conventions.md).",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist/"],
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "pretest:unit": "pnpm --filter @montionugera/entity-spec run build",
    "test:unit": "jest",
    "clean": "rm -rf dist",
    "prepublishOnly": "pnpm test:unit && pnpm run build"
  },
  "license": "MIT",
  "dependencies": { "@montionugera/entity-spec": "workspace:*" },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.16.5",
    "jest": "^29.7.0",
    "ts-jest": "^29.4.0",
    "tsx": "^4.19.2",
    "typescript": "^5.8.3"
  },
  "engines": { "node": ">=18.0.0" },
  "packageManager": "pnpm@9.14.2"
}
```

Copy `tsconfig.json` and `jest.config.js` verbatim from `node/packages/gen-zod/`.
Note there is **no zod dependency** — this package emits plain JSON Schema.

- [ ] **Step 2: Write the failing test**

Create `node/packages/gen-openapi/src/map-field.spec.ts`:

```ts
import { FieldSpec } from '@montionugera/entity-spec';
import { jsonSchemaForField } from './map-field';

describe('jsonSchemaForField', () => {
  it('maps scalars', () => {
    expect(jsonSchemaForField({ name: 'a', type: 'int', min: 0, max: 9 }))
      .toEqual({ type: 'integer', minimum: 0, maximum: 9 });
    expect(jsonSchemaForField({ name: 'b', type: 'float' })).toEqual({ type: 'number' });
    expect(jsonSchemaForField({ name: 'c', type: 'bool' })).toEqual({ type: 'boolean' });
    expect(jsonSchemaForField({ name: 'd', type: 'datetime' }))
      .toEqual({ type: 'string', format: 'date-time' });
  });

  it('maps string constraints to length keywords', () => {
    expect(jsonSchemaForField({ name: 'n', type: 'str', min: 2, max: 80 }))
      .toEqual({ type: 'string', minLength: 2, maxLength: 80 });
  });

  it('emits both format and pattern for email', () => {
    const s = jsonSchemaForField({ name: 'e', type: 'str', format: 'email' }) as
      Record<string, unknown>;
    expect(s.format).toBe('email');
    expect(typeof s.pattern).toBe('string');
  });

  it('renders nullable as a type array', () => {
    expect(jsonSchemaForField({ name: 'b', type: 'datetime', nullable: true }))
      .toEqual({ type: ['string', 'null'], format: 'date-time' });
  });

  it('maps enum, list and obj', () => {
    expect(jsonSchemaForField({ name: 's', type: 'enum', enum: ['a', 'b'] }))
      .toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(jsonSchemaForField({ name: 't', type: 'list', item: { name: 't', type: 'str' } }))
      .toEqual({ type: 'array', items: { type: 'string' } });
    const nested: FieldSpec = {
      name: 'p', type: 'obj',
      fields: [{ name: 'bio', type: 'str', optional: true }],
    };
    expect(jsonSchemaForField(nested)).toEqual({
      type: 'object',
      properties: { bio: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('emits description when present and omits it otherwise', () => {
    expect(jsonSchemaForField({ name: 'x', type: 'str', description: 'hi' }))
      .toEqual({ type: 'string', description: 'hi' });
    expect(jsonSchemaForField({ name: 'x', type: 'str' })).toEqual({ type: 'string' });
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

```bash
cd node && pnpm install && cd packages/gen-openapi && pnpm test:unit
```

Expected: FAIL — `Cannot find module './map-field'`.

- [ ] **Step 4: Implement the mapper**

Create `node/packages/gen-openapi/src/map-field.ts`:

```ts
import { FieldSpec } from '@montionugera/entity-spec';
import { EMAIL_PATTERN, UUID_PATTERN, URI_PATTERN } from './patterns';

export type JsonSchema = Record<string, unknown>;

const BASE_TYPE: Record<string, string> = {
  str: 'string', ref: 'string', int: 'integer', float: 'number',
  bool: 'boolean', datetime: 'string', enum: 'string', list: 'array', obj: 'object',
};

const FORMAT_PATTERN: Record<string, RegExp> = {
  email: EMAIL_PATTERN, uuid: UUID_PATTERN, uri: URI_PATTERN,
};

export function jsonSchemaForField(f: FieldSpec): JsonSchema {
  const base = BASE_TYPE[f.type];
  const s: JsonSchema = { type: f.nullable ? [base, 'null'] : base };

  if (f.type === 'datetime') s.format = 'date-time';
  if (f.type === 'str' || f.type === 'ref') {
    if (f.format) {
      s.format = f.format;
      s.pattern = FORMAT_PATTERN[f.format].source;
    }
    if (f.pattern !== undefined) s.pattern = f.pattern;
    if (f.min !== undefined) s.minLength = f.min;
    if (f.max !== undefined) s.maxLength = f.max;
  }
  if (f.type === 'int' || f.type === 'float') {
    if (f.min !== undefined) s.minimum = f.min;
    if (f.max !== undefined) s.maximum = f.max;
  }
  if (f.type === 'enum' && f.enum) s.enum = [...f.enum];
  if (f.type === 'list') {
    s.items = f.item ? jsonSchemaForField(f.item) : {};
    if (f.min !== undefined) s.minItems = f.min;
    if (f.max !== undefined) s.maxItems = f.max;
  }
  if (f.type === 'obj') {
    s.properties = objectProperties(f.fields ?? [], () => true);
    const required = (f.fields ?? []).filter((n) => !n.optional).map((n) => n.name);
    if (required.length > 0) s.required = required;
    s.additionalProperties = false;
  }
  if (f.description !== undefined) s.description = f.description;
  return s;
}

export function objectProperties(
  fields: FieldSpec[],
  include: (f: FieldSpec) => boolean,
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const f of fields.filter(include)) {
    const nested: FieldSpec =
      f.type === 'obj' && f.fields ? { ...f, fields: f.fields.filter(include) } : f;
    out[f.name] = jsonSchemaForField(nested);
  }
  return out;
}
```

Create `node/packages/gen-openapi/src/patterns.ts` holding copies of the three regex
constants, with a comment pointing at `contracts/rules/entity-spec-validation.md` as the
source of truth. They are duplicated rather than imported because `gen-openapi` must not
depend on `gen-zod` (layering rule).

Create `node/packages/gen-openapi/src/index.ts`:

```ts
export { jsonSchemaForField, objectProperties, type JsonSchema } from './map-field';
export { EMAIL_PATTERN, UUID_PATTERN, URI_PATTERN } from './patterns';
```

- [ ] **Step 5: Run the tests**

```bash
cd node/packages/gen-openapi && pnpm test:unit
```

Expected: PASS — all six cases.

- [ ] **Step 6: Commit**

```bash
git add node/packages/gen-openapi node/pnpm-lock.yaml
git commit -m "feat(gen-openapi): field to JSON Schema mapper (Node)"
```

---

### Task 7: Node gen-openapi components — DTO schemas, envelope and problems

**Files:**
- Create: `node/packages/gen-openapi/src/components.ts`
- Modify: `node/packages/gen-openapi/src/index.ts`
- Test: `node/packages/gen-openapi/src/components.spec.ts`

**Interfaces:**
- Consumes: `jsonSchemaForField`, `objectProperties` from Task 6.
- Produces: `openapiComponents(spec: EntitySpec): { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, JsonSchema> }` and `capitalize(s: string): string`. Task 8 references the component names it emits.

- [ ] **Step 1: Write the failing test**

Create `node/packages/gen-openapi/src/components.spec.ts`:

```ts
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiComponents } from './components';

const { schemas, securitySchemes } = openapiComponents(entitySpec(UserFixture));

describe('openapiComponents', () => {
  it('emits the four DTO shapes plus the envelope', () => {
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining([
      'UserCreate', 'UserUpdate', 'UserRead', 'UserActivateInput',
      'UserPingInput', 'UserListResponse',
    ]));
  });

  it('excludes readonly from create and writeonly from read', () => {
    const create = schemas.UserCreate as { properties: Record<string, unknown> };
    const read = schemas.UserRead as { properties: Record<string, unknown> };
    expect(create.properties).not.toHaveProperty('id');
    expect(create.properties).not.toHaveProperty('loginCount');
    expect(create.properties).toHaveProperty('secretNote');
    expect(read.properties).toHaveProperty('id');
    expect(read.properties).not.toHaveProperty('secretNote');
  });

  it('makes every update property optional', () => {
    expect(schemas.UserUpdate).not.toHaveProperty('required');
    const update = schemas.UserUpdate as { properties: Record<string, unknown> };
    const create = schemas.UserCreate as { properties: Record<string, unknown> };
    expect(Object.keys(update.properties)).toEqual(Object.keys(create.properties));
  });

  it('builds an offset envelope referencing the read schema', () => {
    expect(schemas.UserListResponse).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/UserRead' } },
        total: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['items', 'total', 'limit', 'offset'],
      additionalProperties: false,
    });
  });

  it('emits an empty strict object for an action with no input', () => {
    expect(schemas.UserPingInput).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
  });

  it('maps declared schemes into securitySchemes', () => {
    expect(securitySchemes.bearerAuth).toEqual({
      type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
    });
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

```bash
cd node/packages/gen-openapi && pnpm test:unit -- --testPathPattern=components
```

Expected: FAIL — `Cannot find module './components'`.

- [ ] **Step 3: Implement the components builder**

Create `node/packages/gen-openapi/src/components.ts`:

```ts
import { EntitySpec, FieldSpec, SecurityScheme } from '@montionugera/entity-spec';
import { JsonSchema, jsonSchemaForField, objectProperties } from './map-field';

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function strictObject(fields: FieldSpec[], include: (f: FieldSpec) => boolean): JsonSchema {
  const kept = fields.filter(include);
  const s: JsonSchema = { type: 'object', properties: objectProperties(kept, include) };
  const required = kept.filter((f) => !f.optional).map((f) => f.name);
  if (required.length > 0) s.required = required;
  s.additionalProperties = false;
  return s;
}

function listEnvelope(entity: string, pagination: 'offset' | 'cursor'): JsonSchema {
  const items = { type: 'array', items: { $ref: `#/components/schemas/${entity}Read` } };
  const limit = { type: 'integer', minimum: 1, maximum: 100 };
  if (pagination === 'cursor') {
    return {
      type: 'object',
      properties: { items, nextCursor: { type: ['string', 'null'] } },
      required: ['items', 'nextCursor'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      items,
      total: { type: 'integer', minimum: 0 },
      limit,
      offset: { type: 'integer', minimum: 0 },
    },
    required: ['items', 'total', 'limit', 'offset'],
    additionalProperties: false,
  };
}

export const PROBLEM_SCHEMAS: Record<string, JsonSchema> = {
  Problem: {
    type: 'object',
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string', format: 'uri' },
    },
    required: ['type', 'title', 'status'],
    additionalProperties: false,
  },
  ValidationProblem: {
    type: 'object',
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string', format: 'uri' },
      fields: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'title', 'status', 'fields'],
    additionalProperties: false,
  },
};

function schemeObject(s: SecurityScheme): JsonSchema {
  if (s.type === 'apiKey') {
    return { type: 'apiKey', in: s.in, name: s.paramName };
  }
  const out: JsonSchema = { type: 'http', scheme: s.scheme };
  if (s.bearerFormat !== undefined) out.bearerFormat = s.bearerFormat;
  return out;
}

export function openapiComponents(spec: EntitySpec): {
  schemas: Record<string, JsonSchema>;
  securitySchemes: Record<string, JsonSchema>;
} {
  const e = spec.entity;
  const create = strictObject(spec.fields, (f) => !f.readonly);
  const update = { ...create };
  delete (update as { required?: unknown }).required;

  const schemas: Record<string, JsonSchema> = {
    [`${e}Create`]: create,
    [`${e}Update`]: update,
    [`${e}Read`]: strictObject(spec.fields, (f) => !f.writeonly),
    [`${e}ListResponse`]: listEnvelope(e, spec.pagination),
  };
  for (const a of spec.actions ?? []) {
    schemas[`${e}${capitalize(a.name)}Input`] = strictObject(a.input ?? [], () => true);
  }

  const securitySchemes: Record<string, JsonSchema> = {};
  for (const s of spec.security?.schemes ?? []) {
    securitySchemes[s.name] = schemeObject(s);
  }
  return { schemas, securitySchemes };
}
```

Export `openapiComponents`, `capitalize` and `PROBLEM_SCHEMAS` from `src/index.ts`.

- [ ] **Step 4: Run the tests**

```bash
cd node/packages/gen-openapi && pnpm test:unit
```

Expected: PASS — all six cases.

- [ ] **Step 5: Commit**

```bash
git add node/packages/gen-openapi/src
git commit -m "feat(gen-openapi): DTO components, list envelope, problem schemas (Node)"
```

---

### Task 8: Node gen-openapi paths and full document assembly

**Files:**
- Create: `node/packages/gen-openapi/src/paths.ts`
- Create: `node/packages/gen-openapi/src/document.ts`
- Modify: `node/packages/gen-openapi/src/index.ts`
- Test: `node/packages/gen-openapi/src/paths.spec.ts`
- Test: `node/packages/gen-openapi/src/document.spec.ts`

**Interfaces:**
- Consumes: `openapiComponents`, `capitalize`, `PROBLEM_SCHEMAS` from Task 7.
- Produces: `openapiPaths(spec: EntitySpec): Record<string, JsonSchema>` and `openapiDocument(specs: EntitySpec[], version: string): JsonSchema`. Task 9 mirrors both signatures; Task 10 calls `openapiDocument`.

- [ ] **Step 1: Write the failing tests**

Create `node/packages/gen-openapi/src/paths.spec.ts`:

```ts
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiPaths } from './paths';

const paths = openapiPaths(entitySpec(UserFixture)) as Record<string, Record<string, any>>;

describe('openapiPaths', () => {
  it('emits the five CRUD routes and the action routes', () => {
    expect(Object.keys(paths).sort()).toEqual([
      '/users', '/users/{id}', '/users/{id}/actions/activate', '/users/{id}/actions/ping',
    ]);
    expect(Object.keys(paths['/users']).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/users/{id}']).sort()).toEqual(['delete', 'get', 'patch']);
  });

  it('uses PATCH for update and never PUT', () => {
    expect(paths['/users/{id}']).not.toHaveProperty('put');
    expect(paths['/users/{id}'].patch.requestBody.content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/UserUpdate' });
  });

  it('creates returns 201 referencing the read schema', () => {
    const post = paths['/users'].post;
    expect(Object.keys(post.responses)).toContain('201');
    expect(post.responses['201'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/UserRead' });
  });

  it('delete returns 204 with no content', () => {
    expect(paths['/users/{id}'].delete.responses['204']).toEqual({ description: 'No Content' });
  });

  it('adds pagination and filterable query parameters to list only', () => {
    const names = paths['/users'].get.parameters.map((p: any) => p.name).sort();
    expect(names).toEqual(['email', 'limit', 'offset', 'status']);
    const status = paths['/users'].get.parameters.find((p: any) => p.name === 'status');
    expect(status.schema.enum).toEqual(['inactive', 'active', 'banned']);
    expect(paths['/users'].post.parameters).toBeUndefined();
  });

  it('attaches security only to declared operations', () => {
    expect(paths['/users'].post.security).toEqual([{ bearerAuth: ['user:write'] }]);
    expect(paths['/users'].get.security).toBeUndefined();
    expect(paths['/users/{id}'].delete.security).toEqual([{ bearerAuth: ['user:admin'] }]);
  });

  it('gives an action with a from-state a 409 response', () => {
    const activate = paths['/users/{id}/actions/activate'].post;
    expect(Object.keys(activate.responses)).toContain('409');
    expect(paths['/users/{id}/actions/ping'].post.responses).not.toHaveProperty('409');
  });
});
```

Create `node/packages/gen-openapi/src/document.spec.ts`:

```ts
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiDocument } from './document';

const doc = openapiDocument([entitySpec(UserFixture)], '1.2.0') as Record<string, any>;

describe('openapiDocument', () => {
  it('declares OpenAPI 3.1 and mirrors the contract version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'server-decorator API', version: '1.2.0' });
  });

  it('collects tags and the shared problem schemas', () => {
    expect(doc.tags).toEqual([{ name: 'identity' }]);
    expect(doc.components.schemas).toHaveProperty('Problem');
    expect(doc.components.schemas).toHaveProperty('ValidationProblem');
  });

  it('carries the entity description onto its routes', () => {
    expect(doc.paths['/users'].get.tags).toEqual(['identity']);
  });
});
```

- [ ] **Step 2: Run them to confirm failure**

```bash
cd node/packages/gen-openapi && pnpm test:unit
```

Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 3: Implement paths**

Create `node/packages/gen-openapi/src/paths.ts`:

```ts
import { ActionSpec, EntitySpec, FieldSpec } from '@montionugera/entity-spec';
import { JsonSchema, jsonSchemaForField } from './map-field';
import { capitalize } from './components';

const problem = (status: string, description: string, component = 'Problem') => ({
  [status]: {
    description,
    content: {
      'application/problem+json': { schema: { $ref: `#/components/schemas/${component}` } },
    },
  },
});

const json = (ref: string) => ({
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

function idField(spec: EntitySpec): FieldSpec {
  const f = spec.fields.find((x) => x.role === 'id');
  if (!f) throw new Error(`${spec.entity}: no field with role "id"`);
  return f;
}

function securityFor(spec: EntitySpec, key: string, kind: 'ops' | 'actions'): JsonSchema | null {
  const scopes = spec.security?.[kind]?.[key];
  if (scopes === undefined) return null;
  const scheme = spec.security?.schemes[0];
  if (!scheme) return null;
  return { security: [{ [scheme.name]: scopes }] };
}

function filterParams(spec: EntitySpec): JsonSchema[] {
  return spec.fields
    .filter((f) => f.filterable)
    .map((f) => {
      const { optional: _o, nullable: _n, ...rest } = f;
      return { name: f.name, in: 'query', required: false, schema: jsonSchemaForField(rest) };
    });
}

function paginationParams(spec: EntitySpec): JsonSchema[] {
  const limit = {
    name: 'limit', in: 'query', required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  };
  if (spec.pagination === 'cursor') {
    return [limit, { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }];
  }
  return [
    limit,
    { name: 'offset', in: 'query', required: false,
      schema: { type: 'integer', minimum: 0, default: 0 } },
  ];
}

export function openapiPaths(spec: EntitySpec): Record<string, JsonSchema> {
  const e = spec.entity;
  const base = `/${spec.path}`;
  const id = idField(spec);
  const idParam = {
    name: id.name, in: 'path', required: true, schema: jsonSchemaForField({ ...id, role: undefined }),
  };
  const tags = spec.tags ? { tags: spec.tags } : {};
  const out: Record<string, JsonSchema> = {};
  const collection: Record<string, unknown> = {};
  const item: Record<string, unknown> = {};

  if (spec.ops.includes('list')) {
    const params = [...paginationParams(spec), ...filterParams(spec)]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    collection.get = {
      ...tags, operationId: `list${e}`, parameters: params,
      responses: {
        '200': { description: 'OK', ...json(`${e}ListResponse`) },
        ...(filterParams(spec).length > 0
          ? problem('400', 'Bad Request', 'ValidationProblem') : {}),
      },
      ...(securityFor(spec, 'list', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('create')) {
    collection.post = {
      ...tags, operationId: `create${e}`,
      requestBody: { required: true, ...json(`${e}Create`) },
      responses: {
        '201': { description: 'Created', ...json(`${e}Read`) },
        ...problem('400', 'Bad Request', 'ValidationProblem'),
      },
      ...(securityFor(spec, 'create', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('get')) {
    item.get = {
      ...tags, operationId: `get${e}`, parameters: [idParam],
      responses: { '200': { description: 'OK', ...json(`${e}Read`) }, ...problem('404', 'Not Found') },
      ...(securityFor(spec, 'get', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('update')) {
    item.patch = {
      ...tags, operationId: `update${e}`, parameters: [idParam],
      requestBody: { required: true, ...json(`${e}Update`) },
      responses: {
        '200': { description: 'OK', ...json(`${e}Read`) },
        ...problem('400', 'Bad Request', 'ValidationProblem'),
        ...problem('404', 'Not Found'),
      },
      ...(securityFor(spec, 'update', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('delete')) {
    item.delete = {
      ...tags, operationId: `delete${e}`, parameters: [idParam],
      responses: { '204': { description: 'No Content' }, ...problem('404', 'Not Found') },
      ...(securityFor(spec, 'delete', 'ops') ?? {}),
    };
  }
  if (Object.keys(collection).length > 0) out[base] = collection;
  if (Object.keys(item).length > 0) out[`${base}/{${id.name}}`] = item;

  for (const a of spec.actions ?? []) {
    out[`${base}/{${id.name}}/actions/${a.name}`] = {
      post: {
        ...tags, operationId: `${a.name}${e}`, parameters: [idParam],
        ...(a.description !== undefined ? { description: a.description } : {}),
        requestBody: { required: true, ...json(`${e}${capitalize(a.name)}Input`) },
        responses: {
          '200': { description: 'OK', ...json(`${e}Read`) },
          ...problem('400', 'Bad Request', 'ValidationProblem'),
          ...problem('404', 'Not Found'),
          ...(a.from !== undefined ? problem('409', 'Conflict') : {}),
        },
        ...(securityFor(spec, a.name, 'actions') ?? {}),
      },
    };
  }
  return out;
}
```

Note the `{id}` path template uses the id field's actual name, per the conventions doc.
Adjust the Task 8 test expectations if the fixture's id field is not named `id`.

- [ ] **Step 4: Implement the document assembler**

Create `node/packages/gen-openapi/src/document.ts`:

```ts
import { EntitySpec } from '@montionugera/entity-spec';
import { JsonSchema } from './map-field';
import { PROBLEM_SCHEMAS, openapiComponents } from './components';
import { openapiPaths } from './paths';

export function openapiDocument(specs: EntitySpec[], version: string): JsonSchema {
  const schemas: Record<string, JsonSchema> = { ...PROBLEM_SCHEMAS };
  const securitySchemes: Record<string, JsonSchema> = {};
  const paths: Record<string, JsonSchema> = {};
  const tagNames = new Set<string>();

  for (const spec of specs) {
    const c = openapiComponents(spec);
    Object.assign(schemas, c.schemas);
    Object.assign(securitySchemes, c.securitySchemes);
    Object.assign(paths, openapiPaths(spec));
    for (const t of spec.tags ?? []) tagNames.add(t);
  }

  const doc: JsonSchema = {
    openapi: '3.1.0',
    info: { title: 'server-decorator API', version },
    paths,
    components: { schemas },
  };
  if (tagNames.size > 0) {
    doc.tags = [...tagNames].sort().map((name) => ({ name }));
  }
  if (Object.keys(securitySchemes).length > 0) {
    (doc.components as Record<string, unknown>).securitySchemes = securitySchemes;
  }
  return doc;
}
```

Export `openapiPaths` and `openapiDocument` from `src/index.ts`.

- [ ] **Step 5: Run the tests**

```bash
cd node/packages/gen-openapi && pnpm test:unit
```

Expected: PASS — every case in both new spec files.

- [ ] **Step 6: Commit**

```bash
git add node/packages/gen-openapi/src
git commit -m "feat(gen-openapi): routes, parameters, security and document assembly (Node)"
```

---

### Task 9: Python gen_openapi — complete mirror

One task, because the Python package has no value until it produces the whole document and its
only meaningful test is agreement with Node.

**Files:**
- Create: `python/packages/gen_openapi/pyproject.toml`
- Create: `python/packages/gen_openapi/scripts/check.sh`
- Create: `python/packages/gen_openapi/src/server_decorator_gen_openapi/__init__.py`
- Create: `python/packages/gen_openapi/src/server_decorator_gen_openapi/py.typed`
- Test: `python/packages/gen_openapi/tests/test_document.py`

**Interfaces:**
- Consumes: the EntitySpec dict from `server_decorator_entity.entity_spec`.
- Produces: `json_schema_for_field(f: dict) -> dict`, `openapi_components(spec: dict) -> tuple[dict, dict]`, `openapi_paths(spec: dict) -> dict`, `openapi_document(specs: list[dict], version: str) -> dict` — the same four concepts as Tasks 6-8, snake_cased.

- [ ] **Step 1: Scaffold the package**

Copy `python/packages/gen_pydantic/pyproject.toml` to `python/packages/gen_openapi/` and change
`name` to `server-decorator-gen-openapi`, the description to reference
`contracts/rules/rest-conventions.md`, and remove the `pydantic` dependency — this package
depends only on `server-decorator-entity`. Copy `scripts/check.sh` verbatim. Add the package to
`python/pyproject.toml`'s workspace members.

- [ ] **Step 2: Write the failing test**

Create `python/packages/gen_openapi/tests/test_document.py`:

```python
import json
from pathlib import Path

from server_decorator_entity import entity_spec
from server_decorator_entity.testing.user_fixture import User
from server_decorator_gen_openapi import openapi_document

DOC = openapi_document([entity_spec(User)], "1.2.0")


def test_declares_openapi_31() -> None:
    assert DOC["openapi"] == "3.1.0"
    assert DOC["info"] == {"title": "server-decorator API", "version": "1.2.0"}


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
    golden = Path(__file__).parents[4] / "contracts/fixtures/openapi.valid-user.json"
    if golden.exists():
        assert DOC == json.loads(golden.read_text())
```

- [ ] **Step 3: Run it to confirm failure**

```bash
cd python/packages/gen_openapi && uv run pytest tests -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'server_decorator_gen_openapi'`.

- [ ] **Step 4: Implement the module**

Write `python/packages/gen_openapi/src/server_decorator_gen_openapi/__init__.py`:

```python
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
URI_PATTERN = r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+$"

_BASE_TYPE = {
    "str": "string", "ref": "string", "int": "integer", "float": "number",
    "bool": "boolean", "datetime": "string", "enum": "string",
    "list": "array", "obj": "object",
}
_FORMAT_PATTERN = {"email": EMAIL_PATTERN, "uuid": UUID_PATTERN, "uri": URI_PATTERN}

Include = Callable[[dict[str, Any]], bool]


def json_schema_for_field(f: dict[str, Any]) -> dict[str, Any]:
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
        s["items"] = json_schema_for_field(f["item"]) if f.get("item") else {}
        if "min" in f:
            s["minItems"] = f["min"]
        if "max" in f:
            s["maxItems"] = f["max"]
    if t == "obj":
        nested = f.get("fields", [])
        s["properties"] = object_properties(nested, lambda _f: True)
        required = [n["name"] for n in nested if not n.get("optional")]
        if required:
            s["required"] = required
        s["additionalProperties"] = False
    if "description" in f:
        s["description"] = f["description"]
    return s


def object_properties(fields: list[dict[str, Any]], include: Include) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in [x for x in fields if include(x)]:
        nested = f
        if f["type"] == "obj" and f.get("fields"):
            nested = {**f, "fields": [n for n in f["fields"] if include(n)]}
        out[f["name"]] = json_schema_for_field(nested)
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
            {"name": f["name"], "in": "query", "required": False,
             "schema": json_schema_for_field(bare)}
        )
    return out


def _pagination_params(spec: dict[str, Any]) -> list[dict[str, Any]]:
    limit = {
        "name": "limit", "in": "query", "required": False,
        "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
    }
    if spec["pagination"] == "cursor":
        return [limit, {"name": "cursor", "in": "query", "required": False,
                        "schema": {"type": "string"}}]
    return [limit, {"name": "offset", "in": "query", "required": False,
                    "schema": {"type": "integer", "minimum": 0, "default": 0}}]


def openapi_paths(spec: dict[str, Any]) -> dict[str, Any]:
    e = spec["entity"]
    base = "/" + spec["path"]
    id_field = next((f for f in spec["fields"] if f.get("role") == "id"), None)
    if id_field is None:
        raise ValueError(f'{e}: no field with role "id"')
    id_bare = {k: v for k, v in id_field.items() if k != "role"}
    id_param = {"name": id_field["name"], "in": "path", "required": True,
                "schema": json_schema_for_field(id_bare)}
    tags = {"tags": spec["tags"]} if "tags" in spec else {}
    ops = spec["ops"]
    out: dict[str, Any] = {}
    collection: dict[str, Any] = {}
    item: dict[str, Any] = {}
    filters = _filter_params(spec)

    if "list" in ops:
        params = sorted(_pagination_params(spec) + filters, key=lambda p: p["name"])
        responses = {"200": {"description": "OK", **_json(f"{e}ListResponse")}}
        if filters:
            responses.update(_problem("400", "Bad Request", "ValidationProblem"))
        collection["get"] = {**tags, "operationId": f"list{e}", "parameters": params,
                             "responses": responses, **_security_for(spec, "list", "ops")}
    if "create" in ops:
        collection["post"] = {
            **tags, "operationId": f"create{e}",
            "requestBody": {"required": True, **_json(f"{e}Create")},
            "responses": {"201": {"description": "Created", **_json(f"{e}Read")},
                          **_problem("400", "Bad Request", "ValidationProblem")},
            **_security_for(spec, "create", "ops"),
        }
    if "get" in ops:
        item["get"] = {
            **tags, "operationId": f"get{e}", "parameters": [id_param],
            "responses": {"200": {"description": "OK", **_json(f"{e}Read")},
                          **_problem("404", "Not Found")},
            **_security_for(spec, "get", "ops"),
        }
    if "update" in ops:
        item["patch"] = {
            **tags, "operationId": f"update{e}", "parameters": [id_param],
            "requestBody": {"required": True, **_json(f"{e}Update")},
            "responses": {"200": {"description": "OK", **_json(f"{e}Read")},
                          **_problem("400", "Bad Request", "ValidationProblem"),
                          **_problem("404", "Not Found")},
            **_security_for(spec, "update", "ops"),
        }
    if "delete" in ops:
        item["delete"] = {
            **tags, "operationId": f"delete{e}", "parameters": [id_param],
            "responses": {"204": {"description": "No Content"}, **_problem("404", "Not Found")},
            **_security_for(spec, "delete", "ops"),
        }
    if collection:
        out[base] = collection
    if item:
        out[f"{base}/{{{id_field['name']}}}"] = item

    for a in spec.get("actions", []):
        name = a["name"][0].upper() + a["name"][1:]
        responses = {"200": {"description": "OK", **_json(f"{e}Read")},
                     **_problem("400", "Bad Request", "ValidationProblem"),
                     **_problem("404", "Not Found")}
        if "from" in a:
            responses.update(_problem("409", "Conflict"))
        post: dict[str, Any] = {**tags, "operationId": f"{a['name']}{e}",
                                "parameters": [id_param]}
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
```

Create an empty `py.typed` marker alongside it. Key insertion order does not affect
byte-identity — `canonical_json` sorts keys recursively — but keeping the order aligned with
`paths.ts` makes the parity diff in Task 10 readable when it fails.

- [ ] **Step 5: Run the checks**

```bash
cd python && bash scripts/check.sh
```

Expected: PASS — ruff, ruff format, mypy strict and pytest green for all four packages.

- [ ] **Step 6: Commit**

```bash
git add python/packages/gen_openapi python/pyproject.toml python/uv.lock
git commit -m "feat(gen_openapi): OpenAPI 3.1 document generator (Python)"
```

---

### Task 10: Case-driven cross-language coverage against entity-spec.cases.json

`contracts/fixtures/entity-spec.cases.json` is the repo's cross-language validation contract —
CLAUDE.md requires that a generator behaviour change add a case there and that **both**
languages pass it. The DTO generators already do this; the OpenAPI generators must too.

**Files:**
- Modify: `contracts/fixtures/entity-spec.cases.json`
- Create: `node/packages/gen-openapi/src/cases.spec.ts`
- Create: `python/packages/gen_openapi/tests/test_cases.py`

**Interfaces:**
- Consumes: `openapiDocument` / `openapi_document` from Tasks 8 and 9.
- Produces: the case list both languages are held to. Task 11's golden document is the
  single-entity end-to-end check; this task is the per-behaviour matrix.

- [ ] **Step 1: Add the OpenAPI-specific cases**

Append cases to `contracts/fixtures/entity-spec.cases.json` covering behaviours the existing
DTO cases do not reach. Each case is an EntitySpec plus the expectations both languages assert:

- an entity whose `ops` is `["list"]` only — proves absent ops emit no routes
- an entity with `pagination: "cursor"` — proves the alternate envelope and `cursor` query param
- an entity with no `filterable` field — proves `list` carries no 400 response
- an entity with no `security` block — proves every operation is public and no
  `securitySchemes` key is emitted
- an entity with an `apiKey` scheme — proves the `in`/`paramName` mapping
- an action with `from` and one without — proves 409 appears only on the former
- a `nullable` field inside a nested `obj` — proves the type-array rendering recurses

- [ ] **Step 2: Write the Node case runner**

Create `node/packages/gen-openapi/src/cases.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntitySpec } from '@montionugera/entity-spec';
import { openapiDocument } from './document';

const cases = JSON.parse(
  readFileSync(join(__dirname, '../../../../contracts/fixtures/entity-spec.cases.json'), 'utf8'),
) as { openapi?: Array<{ name: string; spec: EntitySpec; expect: Record<string, unknown> }> };

describe('entity-spec.cases.json — openapi', () => {
  for (const c of cases.openapi ?? []) {
    it(c.name, () => {
      const doc = openapiDocument([c.spec], '1.2.0') as Record<string, any>;
      for (const [pointer, expected] of Object.entries(c.expect)) {
        const actual = pointer
          .split('/')
          .filter(Boolean)
          .reduce<any>((acc, k) => (acc === undefined ? undefined : acc[k]), doc);
        expect({ pointer, actual }).toEqual({ pointer, actual: expected });
      }
    });
  }

  it('runs at least one case', () => {
    expect((cases.openapi ?? []).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Write the Python case runner**

Create `python/packages/gen_openapi/tests/test_cases.py`:

```python
import json
from pathlib import Path
from typing import Any

import pytest
from server_decorator_gen_openapi import openapi_document

CASES = json.loads(
    (Path(__file__).parents[4] / "contracts/fixtures/entity-spec.cases.json").read_text()
).get("openapi", [])


def _resolve(doc: dict[str, Any], pointer: str) -> Any:
    node: Any = doc
    for key in [k for k in pointer.split("/") if k]:
        if node is None:
            return None
        node = node.get(key) if isinstance(node, dict) else node[int(key)]
    return node


def test_at_least_one_case() -> None:
    assert len(CASES) > 0


@pytest.mark.parametrize("case", CASES, ids=lambda c: str(c["name"]))
def test_case(case: dict[str, Any]) -> None:
    doc = openapi_document([case["spec"]], "1.2.0")
    for pointer, expected in case["expect"].items():
        assert _resolve(doc, pointer) == expected, pointer
```

- [ ] **Step 4: Run both suites**

```bash
cd node/packages/gen-openapi && pnpm test:unit && cd ../../../python && bash scripts/check.sh
```

Expected: PASS both. A case failing in exactly one language is the divergence this task exists
to catch — fix the generator, never the case, unless the case contradicts
`contracts/rules/rest-conventions.md`.

- [ ] **Step 5: Confirm the existing DTO generators still pass the file**

```bash
cd node/packages/gen-zod && pnpm test:unit
cd ../../../python/packages/gen_pydantic && bash scripts/check.sh
```

Expected: PASS — the new `openapi` key is additive and the DTO runners ignore it.

- [ ] **Step 6: Commit**

```bash
git add contracts/fixtures/entity-spec.cases.json \
        node/packages/gen-openapi/src/cases.spec.ts \
        python/packages/gen_openapi/tests/test_cases.py
git commit -m "test(gen-openapi): case-driven cross-language coverage"
```

---

### Task 11: Golden document, parity script and meta-schema validation

**Files:**
- Create: `node/packages/gen-openapi/scripts/emit-openapi.ts`
- Create: `python/packages/gen_openapi/scripts/emit_openapi.py`
- Create: `contracts/fixtures/openapi.valid-user.json`
- Create: `scripts/check-openapi-parity.sh`
- Modify: `contracts/scripts/validate.sh`

**Interfaces:**
- Consumes: `openapiDocument` (Task 8) and `openapi_document` (Task 9); the case coverage from Task 10.
- Produces: the committed golden document and a parity gate every later change must pass.

- [ ] **Step 1: Write both emitter scripts**

`node/packages/gen-openapi/scripts/emit-openapi.ts` — model it on
`node/packages/entity/scripts/emit-fixture.ts`:

```ts
import { canonicalJson, entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openapiDocument } from '../src/document';

const version = readFileSync(join(__dirname, '../../../../contracts/VERSION'), 'utf8').trim();
process.stdout.write(canonicalJson(openapiDocument([entitySpec(UserFixture)], version)));
```

`python/packages/gen_openapi/scripts/emit_openapi.py`:

```python
from pathlib import Path
import sys

from server_decorator_entity import entity_spec
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.testing.user_fixture import User
from server_decorator_gen_openapi import openapi_document

version = (Path(__file__).parents[4] / "contracts/VERSION").read_text().strip()
sys.stdout.write(canonical_json(openapi_document([entity_spec(User)], version)))
```

- [ ] **Step 2: Generate the golden document from the Node emitter**

```bash
cd node/packages/gen-openapi && pnpm exec tsx scripts/emit-openapi.ts \
  > ../../../contracts/fixtures/openapi.valid-user.json
```

- [ ] **Step 3: Write the parity script**

Create `scripts/check-openapi-parity.sh`, modelled on `check-entity-parity.sh`:

```bash
#!/usr/bin/env bash
# Assert TS and Python emit a byte-identical OpenAPI document, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/openapi.valid-user.json
ts_out=$(cd node/packages/gen-openapi && pnpm exec tsx scripts/emit-openapi.ts)
py_out=$(cd python && uv run --package server-decorator-gen-openapi \
  python packages/gen_openapi/scripts/emit_openapi.py)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS OpenAPI != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY OpenAPI != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: openapi parity (TS == PY == contract fixture)"
```

```bash
chmod +x scripts/check-openapi-parity.sh
```

- [ ] **Step 4: Run it and fix Python until it agrees**

```bash
bash scripts/check-openapi-parity.sh
```

Expected on first run: FAIL with a diff. Work the diff down to zero by correcting the Python
module — the Node output is the reference for *content*, but neither language is privileged for
*decisions*: if the diff reveals Node breaking `contracts/rules/rest-conventions.md`, fix Node
and regenerate the golden file.

- [ ] **Step 5: Add meta-schema validation to the contract lane**

In `contracts/scripts/validate.sh`, add a step that validates the golden document against the
OpenAPI 3.1 meta-schema:

```bash
echo "Validating OpenAPI document against the 3.1 meta-schema..."
npx --yes @redocly/cli@1 lint contracts/fixtures/openapi.valid-user.json \
  --format=stylish --skip-rule=info-license --skip-rule=operation-4xx-response \
  || { echo "FAIL: openapi.valid-user.json is not a valid OpenAPI 3.1 document" >&2; exit 1; }
```

- [ ] **Step 6: Verify the whole contract lane**

```bash
bash contracts/scripts/validate.sh && bash scripts/check-openapi-parity.sh
```

Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add contracts scripts/check-openapi-parity.sh \
        node/packages/gen-openapi/scripts python/packages/gen_openapi/scripts
git commit -m "test(contracts): golden OpenAPI document and cross-language parity gate"
```

---

### Task 12: ADR 0008, CI wiring and version lockstep

**Files:**
- Create: `docs/adr/0008-authorization-metadata-in-contract.md`
- Modify: `docs/adr/README.md`
- Modify: `.github/workflows/ci-contracts.yml`
- Modify: `.github/workflows/ci-node.yml`
- Modify: `.github/workflows/ci-python.yml`
- Modify: `scripts/check-versions.sh`
- Modify: `scripts/bump-version.sh`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing downstream — this task closes the release.

- [ ] **Step 1: Write ADR 0008**

Create `docs/adr/0008-authorization-metadata-in-contract.md` following the format of
`docs/adr/0006-cross-language-consumption.md`. It must record:

- **Context** — entity-spec 1.2.0 adds an OpenAPI generator; a truthful API description has to
  state which operations require credentials.
- **Decision** — declare named security schemes (closed enum `http` | `apiKey`) plus per-op and
  per-action **scope strings**. Scopes are opaque: no hierarchy, no wildcards, no containment.
- **Rejected: roles.** Role names are deployment-specific and churn; a wire contract shared
  across services and languages must not assert an org model. Roles expand to scopes in the
  identity provider, before the request arrives.
- **Rejected: object-level authorization.** "Only the owner may update this record" depends on
  the loaded row at request time; a static per-operation declaration cannot express it. It
  belongs in an adapter or handler, permanently.
- **Consequences** — the contract declares requirements and never enforces them; nothing in 1.2
  rejects an unauthorized request; adapters in 1.3 carry enforcement.

Add the row to `docs/adr/README.md`.

- [ ] **Step 2: Add the new packages to the version tooling**

Update `scripts/check-versions.sh` and `scripts/bump-version.sh` to include
`node/packages/gen-openapi/package.json` and `python/packages/gen_openapi/pyproject.toml`.

- [ ] **Step 3: Verify lockstep**

```bash
bash scripts/check-versions.sh
```

Expected: `OK: all packages at 2.0.4` — now covering eight packages.

- [ ] **Step 4: Wire CI**

In `ci-contracts.yml`, add a step running `bash scripts/check-openapi-parity.sh` after the
existing entity-parity step (it needs both Node and Python toolchains — copy the setup steps
from the entity-parity job). In `ci-node.yml` and `ci-python.yml`, confirm the recursive
`pnpm -r` / per-package `check.sh` invocations already pick the new packages up; if either
enumerates packages explicitly, add the new ones.

- [ ] **Step 5: Update the docs**

Add to `CLAUDE.md`'s command table:

```markdown
| gen-openapi tests | `cd node/packages/gen-openapi && pnpm test:unit` |
| gen_openapi tests | `cd python/packages/gen_openapi && bash scripts/check.sh` |
| OpenAPI parity | `bash scripts/check-openapi-parity.sh` (asserts Node and Python emit byte-identical OpenAPI, equal to `contracts/fixtures/openapi.valid-user.json`) |
```

Add the two new packages to the entity-spec table in `README.md`, and add
`contracts/rules/rest-conventions.md` to the layer-1 description in `CLAUDE.md`.

- [ ] **Step 6: Full green run**

```bash
cd node && pnpm -r test:unit && pnpm -r run build && cd ..
cd python && bash scripts/check.sh && cd ..
bash scripts/check-entity-parity.sh
bash scripts/check-openapi-parity.sh
bash scripts/check-versions.sh
bash contracts/scripts/validate.sh
```

Expected: every command PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/adr .github/workflows scripts CLAUDE.md README.md
git commit -m "docs(adr): 0008 authorization metadata in the wire contract; wire CI"
```

---

## Acceptance

The release is done when all nine criteria in the spec's Acceptance section hold, verified by
the single command block in Task 12 Step 6, with the per-behaviour matrix in Task 10 green in
both languages.

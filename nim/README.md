# Nim — `server_decorator` (EntitySpec IR producer + OpenAPI generator)

Declare an entity with a `restful` block and field pragmas; emit the EntitySpec IR byte-identical to
the Node (`@montionugera/entity-spec`), Python (`server-decorator-entity`) and Go (`go/entity`)
producers, and an OpenAPI 3.1 document byte-identical to the Node/Python `gen-openapi` packages.
Conformance is proven by byte parity with `contracts/fixtures/entity-spec.valid-user.json` and
`contracts/fixtures/openapi.valid-user.json`.

Package: `server_decorator` · Nim **2.2.12** (pinned in CI) · standard library only · versions move
in lockstep with the other lanes (`nim/server_decorator.nimble` `version`, asserted by
`scripts/check-versions.sh`, rewritten by `scripts/bump-version.sh`).

## Install

Not on the nimble directory. Install from the git tag that matches the other lanes:

```bash
nimble install "https://github.com/montionugera/node-server-decorator@#vX.Y.Z?subdir=nim"
```

> The `@#tag?subdir=` URL form is untested against a published tag (the package is not yet tagged). If nimble
> rejects it, try `...?subdir=nim@#vX.Y.Z`, or clone the repo and run `nimble install` inside `nim/`.
(`nimble install` needs the `nim/` subdir because the repository root is a polyglot workspace.)

## Declare an entity

```nim
import std/times            # DateTime fields
import server_decorator/entity

restful "users", description = "A registered user account", tags = ["identity"],
        transports = [rest, rpc, sse, ws],
        security = SecuritySpec(
          schemes: @[SecurityScheme(name: "bearerAuth", `type`: "http",
                                    scheme: some("bearer"), bearerFormat: some("JWT"))],
          ops: @[("create", @["user:write"]), ("update", @["user:write"]), ("delete", @["user:admin"])],
          actions: @[("activate", @["user:admin"])]):
  type
    Profile* = object                        # nested `obj` types live in the SAME block …
      bio* {.max: 500, optional.}: string
    User* = object                           # … and the LAST type is the entity
      id* {.role: "id", readonly.}: string
      email* {.description: "Primary contact address", format: "email", filterable.}: string
      name* {.min: 2, max: 80.}: string
      status* {.enumOf: ["inactive", "active", "banned"], filterable.}: string
      loginCount* {.min: 0, readonly.}: int
      tags*: seq[string]
      profile* {.optional.}: Profile
      birthday* {.nullable, optional.}: DateTime
      score* {.min: 0, optional.}: float    # min/max are integers even on float fields
      active* {.optional.}: bool
      secretNote* {.max: 100, writeonly, optional.}: string
  action "activate", description = "Move a dormant account back to active":
    transition "status", "inactive", "active"
    input:
      reason {.max: 200, optional.}: string
  action "ping"

echo canonical(entitySpec(User))            # the IR, canonical JSON, byte-identical to the fixture
```

`restful` is a plain block macro; the pragmas are read from the AST and stripped, so `User` and
`Profile` are ordinary Nim objects. The spec is a compile-time `const`: a typo in a pragma, an
unknown type, a reserved wire name (`json`, `model_dump`, …), a non-portable regex, or a security
rule violation is a **compile error** naming the field (same messages as `validate.ts`).

| Field type | IR `type` | Pragmas |
|---|---|---|
| `string` | `str` | `format: "email"\|"uuid"\|"uri"`, `pattern`, `min`/`max` (length) |
| `string` + `enumOf: [..]` | `enum` | — |
| `string` + `refTo: "Entity"` | `ref` | — |
| `int` / `float` | `int` / `float` | `min`/`max` (integer literals) |
| `bool` | `bool` | — |
| `DateTime` | `datetime` | — |
| `seq[T]` | `list` (item recursive, item name = field name) | `min`/`max` (items) |
| nested object type | `obj` | — |
Flags on any field: `optional nullable readonly writeonly filterable`; `description: "…"`; `role: "id"`.

Options: `description`, `tags`, `transports` (default `[rest]`), `ops` (default all five),
`pagination` (`offset` default | `cursor`), `security`. Actions: `description`, `transactional = false`,
`transition stateField, from, to`, `input:` fields.

## OpenAPI

```nim
import server_decorator          # entity + gen_openapi
echo openapiCanonical(@[entitySpec(User)], "1.2.0")
```
`openapiDocument` returns the `JsonNode`; `openapiCanonical` serialises it canonically.

## Byte-format rules (for contributors)

- Keys sorted by Unicode code point at every level; no whitespace; no trailing newline.
- Absent optionals omitted; boolean flags only when `true`; `actions`/`input` only when non-empty;
  `transactional` only when `false`; `tags: some(@[])` emits `"tags":[]` (Node behaviour).
- Non-ASCII, `< > &`, U+2028/2029 are written raw; control chars 0x00–0x1F use the JSON.stringify forms
  (`\b \f \n \r \t`, otherwise lowercase `\u00xx`). `canonical.nim` hand-rolls this because
  `std/json.escapeJson` emits uppercase hex (`\u001F`) and would break byte parity.
- `min`/`max` are `Option[int]`, so the IR never contains a Nim float and `1.0`-style rendering
  never reaches the wire.

## Develop

```bash
export PATH=$HOME/.nimble/bin:$PATH      # maintainer Mac: Nim 2.2.12 lives here (see CLAUDE.md)
cd nim
nimble check                             # manifest
nim check --hints:off src/server_decorator.nim
nimble test                              # t_canonical t_validate t_entity t_compile_errors t_openapi t_cases
nim r --hints:off examples/emit_fixture.nim | cmp - ../contracts/fixtures/entity-spec.valid-user.json
nim r --hints:off examples/emit_openapi.nim | cmp - ../contracts/fixtures/openapi.valid-user.json
```
Cross-lane: `bash scripts/check-entity-parity.sh`, `bash scripts/check-openapi-parity.sh`,
`bash scripts/check-versions.sh` from the repo root. Zero dependencies — do not commit `nimble.lock`.

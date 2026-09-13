---
title: "Nim lane: fourth language — entity IR producer + OpenAPI emitter in Nim"
id: I-007
status: idea
---

# Nim lane: fourth language — entity IR producer + OpenAPI emitter in Nim

First of four Nim-lane features (I-007 entity + OpenAPI → I-008 DTO validators → I-009 core
decorators → I-010 queue decorators). This one establishes the `nim/` package, its CI lane, and
lockstep versioning; the later three build on it.

## Problem

The EntitySpec IR is emitted by Node, Python and (since F-005) Go, all byte-identical against
`contracts/fixtures/entity-spec.valid-user.json`. Nim services cannot participate. Unlike Go, Nim
has macros, so it can offer the *decorator* ergonomics of the Node/Python packages, not only a
builder — and it can also carry the OpenAPI generator (deferred for Go).

## Goals

1. `nim/` package `server_decorator` that declares entities with **pragma macros** and emits the
   EntitySpec IR (`specVersion` `1.2.0`) **byte-identical** to `entity-spec.valid-user.json`.
2. `server_decorator/gen_openapi` port emitting OpenAPI 3.1 **byte-identical** to
   `contracts/fixtures/openapi.valid-user.json`, passing the OpenAPI-relevant cases in
   `contracts/fixtures/entity-spec.cases.json` exactly as the Node/Python generators do.
3. Wired into `scripts/check-entity-parity.sh`, `scripts/check-openapi-parity.sh`,
   `scripts/check-versions.sh`, `scripts/bump-version.sh`, the `ci-node.yml` publish allowlist,
   `ci-contracts.yml`, and a new `ci-nim.yml`.

## Non-goals

- DTO validators (I-008), `cached`/`tracked` (I-009), queue decorators (I-010).
- HTTP framework adapters; registering the package in `nim-lang/packages` (consumers install by
  git URL + the existing `vX.Y.Z` tag).
- Any change under `contracts/`.
- Fixing the known Go divergence (Go drops `"tags":[]` / empty security maps via `omitempty`,
  Node emits them). Nim follows **Node**. The Go gap is filed as a separate idea.

## Design

### Package layout (single nimble package, mirrors Go's single module)

```
nim/
  server_decorator.nimble        # version = "2.0.4" (lockstep; single source for check/bump)
  src/server_decorator/entity.nim         # pragma macros, EntitySpec types, registry
  src/server_decorator/entity/canonical.nim   # canonical JSON emitter
  src/server_decorator/gen_openapi.nim    # IR → OpenAPI 3.1 document (JsonNode) + canonical string
  examples/user.nim              # the fixture entity (User) — parity input
  examples/emit_fixture.nim      # prints entity IR to stdout      (parity script input)
  examples/emit_openapi.nim      # prints OpenAPI to stdout        (parity script input)
  tests/                         # nimble test: t_entity, t_canonical, t_openapi, t_cases
  README.md
```
Layering rule holds inside the package: `gen_openapi` imports `entity`; `entity` imports only stdlib.

### Declaration API (pragma macros — the Nim analogue of `@Restful`/`@restful`)

```nim
import server_decorator/entity

restful "users":                      # path; entity name = type name
  ## Optional description
  type User = object
    id       {.role: "id", readonly.}: string
    email    {.format: "email", filterable.}: string
    age      {.min: 0, max: 150, optional.}: int
    status   {.enumOf: ["active","inactive"].}: string
    tags     {.optional.}: seq[string]
    profile  {.optional.}: Profile          # nested object type declared with `entityObj`
    createdAt {.readonly.}: DateTime

action User, "activate":
  transition "status", "inactive", "active"

let ir = spec(User)                # EntitySpec (typed object)
echo ir.toCanonicalJson()          # byte-identical string
```

- Field types: `str`(string) `int` `float` `bool` `datetime`(DateTime) `enum`(string + `enumOf`)
  `ref` (`{.refTo: "Other".}`) `list` (`seq[T]`, `item` recursive) `obj` (nested object type).
- Field modifiers: `description`, `role: "id"`, `format` (email|uuid|uri), `enumOf`, `min`/`max`
  (integers; `Option[int]` so an explicit `0` survives), `pattern`, flags `optional` `nullable`
  `readonly` `writeonly` `filterable` (emitted only when true), `refTo`.
- Entity-level: `transports` (default `[rest]`), `ops` (default all five), `pagination`
  (default `offset`), `description`, `tags`, `security` (schemes + per-op/per-action scopes).
- Actions: name, description, `transition(stateField, from, to)`, `input` fields, `transactional`
  (emitted only as `false`, same as the other lanes).
- A typo in a pragma or an unknown field type is a **compile error** with a message naming the
  field.
- Runtime registry: `registeredSpecs(): seq[EntitySpec]`, mirroring Node's `registry.ts`.

### Canonical JSON (the byte-identity contract)

Mirrors `node/packages/entity/src/canonical.ts` / Python `json.dumps(sort_keys=True,
separators=(",",":"), ensure_ascii=False)`:
- keys sorted by Unicode code point at every level (including `security.ops`/`.actions` maps);
- no whitespace, no trailing newline; absent optionals omitted; flags only when true;
- non-ASCII raw (never `\uXXXX`); `< > &` unescaped; U+2028/U+2029 **raw**;
- `min`/`max` are integers, so no float formatting rules apply to the IR.
Golden test: `go/entity/testdata/html-escape.json` (Node-produced) is reused verbatim.
The emitter is hand-written over `JsonNode` (std/json) — no third-party canonical-JSON lib exists.

### OpenAPI

Straight port of `node/packages/gen-openapi/src` (`map-field`, `components`, `paths`, ~360 LOC),
producing a `JsonNode` and serialising through the same canonical emitter. Must equal
`contracts/fixtures/openapi.valid-user.json` byte-for-byte. Floats: OpenAPI output contains no
floats in the fixture; if a case introduces one, Nim's `std/json` renders whole floats as `1.0`
(Python style, differs from JS) — the plan must add an explicit check and a formatting shim if
`cases.json` exercises it.

### Wiring

| File | Change |
|---|---|
| `scripts/check-entity-parity.sh` | capture `nim r --hints:off nim/examples/emit_fixture.nim`; success line `TS == PY == GO == NIM == contract fixture` |
| `scripts/check-openapi-parity.sh` | add NIM capture + compare |
| `scripts/check-versions.sh` / `bump-version.sh` | grep/sed `^version\s*=\s*"…"` in `nim/server_decorator.nimble` |
| `.github/workflows/ci-nim.yml` (new) | triggers `nim/**`, `contracts/**`, itself; `jiro4989/setup-nim-action` pinned to Nim **2.2.12**; `nim check`, `nimble test`, both parity scripts |
| `ci-contracts.yml` | nim paths in filters; setup-nim in `entity-parity` + `openapi-parity` jobs |
| `ci-node.yml` publish | add `nim/server_decorator.nimble` to the `git add` allowlist |
| Docs | `nim/README.md`; CLAUDE.md commands table + "Things that will trip you up" (nimble lockfile policy, Nim version pin); `go/README.md` untouched |

## Acceptance criteria

- AC1 `bash scripts/check-entity-parity.sh` prints `TS == PY == GO == NIM == contract fixture`, exit 0.
- AC2 `bash scripts/check-openapi-parity.sh` includes NIM and exits 0.
- AC3 `cd nim && nimble test` passes: fixture parity, html-escape golden, key-order test, the
  OpenAPI subset of `entity-spec.cases.json`, compile-error tests for a misspelled pragma
  (`nim check` on a negative example asserting the expected error text).
- AC4 `bash scripts/check-versions.sh` passes and fails if the nimble version is edited alone;
  `bump-version.sh patch` rewrites all four lanes (dry-run in a scratch copy).
- AC5 `ci-nim.yml` green on the release PR; `ci-contracts.yml` parity jobs green with Nim included.
- AC6 Nim toolchain pin (2.2.12) recorded in `nim/README.md`, CI, and CLAUDE.md.

## Assumptions (provisional until verified in the plan)

- A1 Nim 2.2.12 is the stable release and `jiro4989/setup-nim-action` can pin it.
- A2 `std/json` `escapeJson` leaves non-ASCII and U+2028 raw (else the emitter escapes by hand).
- A3 `entity-spec.cases.json` has a distinguishable OpenAPI subset the Node/Python generators consume.
- A4 nimble does not need a lockfile committed for a zero-dependency package.

## Decisions (batch-grill, 2026-09-13)

- Scope → user chose **everything**; split into I-007…I-010, this is the first.
- API shape → **pragma macros** (user: "robust and clean like Python @decorator"); Go's builder was
  a Go-only constraint.
- Async runtime for later lanes → stdlib `asyncdispatch` (default, not asked) — the maintained Redis
  and RabbitMQ clients use it.
- Package layout → one nimble package, submodules (default, not asked) — mirrors Go; nimble
  packages are heavyweight to multiply.
- OpenAPI in this feature → yes (user scope); it is the same ~360 LOC port F-005 skipped.

---
title: "Nim lane: fourth language — entity IR producer + OpenAPI emitter in Nim"
id: F-006
status: refined
from_idea: I-007
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
  server_decorator.nimble        # version = "<lockstep>" (2.0.4 at spec time; ci-node.yml:58 auto-bumps on push to main)
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

### Declaration API (block macro + custom field pragmas — the Nim analogue of `@Restful`/`@restful`)

`restful` is a plain **block macro** (stable Nim); per-field `{.pragma.}` annotations are read from
the AST by that macro. Nothing relies on the *experimental* macro-pragmas-on-type/var feature.

```nim
import server_decorator/entity

restful "users":                      # path; entity name = type name
  ## Optional description
  type
    Profile = object                      # nested `obj` types are declared in the SAME block
      bio    {.max: 500, optional.}: string
    User = object
      id       {.role: "id", readonly.}: string
      email    {.format: "email", filterable.}: string
      age      {.min: 0, max: 150, optional.}: int
      status   {.enumOf: ["active","inactive"].}: string
      tags     {.optional.}: seq[string]
      profile  {.optional.}: Profile      # resolved from the block; an outside type is a compile error
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
- Nested `obj` types **must be declared inside the same `restful` block** (verified on Nim 2.2.12:
  the block macro sees field pragmas only for types in its own AST; resolving an external type
  would need a typed `getImpl` pass — deferred, and a compile error names the offending field).
- Spec accumulation is compile-time: the block macro assembles the whole `EntitySpec`. This is the
  analogue of Node's `registry.ts` per-constructor accumulator (`specFor`/`addField`/`addAction` —
  it exposes nothing enumerable). No runtime enumeration API in this feature; `spec(User)` is the
  only entry point.

### Canonical JSON (the byte-identity contract)

Mirrors `node/packages/entity/src/canonical.ts` / Python `json.dumps(sort_keys=True,
separators=(",",":"), ensure_ascii=False)`:
- keys sorted by Unicode code point at every level (including `security.ops`/`.actions` maps);
- no whitespace, no trailing newline; absent optionals omitted; flags only when true;
- non-ASCII raw (never `\uXXXX`); `< > &` unescaped; U+2028/U+2029 **raw**;
- `min`/`max` are `Option[int]` **even on `float` fields** (the fixture's `score` is `float` with
  `min: 0`; the schema types min/max as `number, multipleOf 1`). So the IR never holds a Nim float
  and `std/json`'s `0.0` rendering never reaches the wire — this is load-bearing, not incidental.
Golden test: `go/entity/testdata/html-escape.json` (Node-produced) is reused verbatim.
The emitter is hand-written over `JsonNode` (std/json) — no third-party canonical-JSON lib exists.

### OpenAPI

Straight port of `node/packages/gen-openapi/src` (`map-field`, `components`, `paths`, `document`,
`patterns`, `index`; 359 LOC),
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
| `.github/workflows/ci-nim.yml` (new) | triggers `nim/**`, `contracts/**`, itself; `jiro4989/setup-nim-action@v2` pinned to Nim **2.2.12**; `nim check` + `nimble test` only (mirror `ci-go.yml` lines 15-27) — parity scripts are NOT run here, they belong to `ci-contracts.yml` |
| `ci-contracts.yml` | add `nim/**` to both path filters (pull_request lines 13-21, push lines 24-32); add setup-nim to the **single** `entity-parity` job (lines 64-79), which already runs both parity scripts |
| `ci-node.yml` publish | add `nim/server_decorator.nimble` to the `git add` allowlist (line 106) — omitting it makes the post-merge publish job fail on `main` |
| Docs | `nim/README.md`; CLAUDE.md commands table + "Things that will trip you up" (nimble lockfile policy, Nim version pin); `go/README.md` untouched |

**Blast radius (R1):** once the parity scripts invoke `nim`, any run without a Nim toolchain goes red —
setup-nim must land in `ci-contracts.yml` in the same PR, and local runs need `~/.nimble/bin` on
`PATH`. Undo = revert the script/YAML edits; no data or published artifact is touched.

## Acceptance criteria

- AC1 `bash scripts/check-entity-parity.sh` prints `TS == PY == GO == NIM == contract fixture`, exit 0.
- AC2 `bash scripts/check-openapi-parity.sh` includes NIM and exits 0.
- AC3 `cd nim && nimble test` passes: fixture parity, html-escape golden, key-order test, the
  OpenAPI subset of `entity-spec.cases.json`, compile-error tests for a misspelled pragma
  (`nim check` on a negative example asserting the expected error text).
- AC4 `bash scripts/check-versions.sh` passes and fails if the nimble version is edited alone;
  `bump-version.sh patch` rewrites all four lanes (dry-run in a scratch copy).
- AC5 `ci-nim.yml` green on the release PR; the `ci-contracts.yml` `entity-parity` job green with Nim included.
- AC6 Nim toolchain pin (2.2.12) recorded in `nim/README.md`, CI, and CLAUDE.md.

## Assumptions (provisional until verified in the plan)

- A1 ✅ verified: `jiro4989/setup-nim-action@v2` with `nim-version: '2.2.12'`.
- A2 ✅ verified on Nim 2.2.12: `escapeJson` leaves non-ASCII, `< > &`, U+2028/U+2029 raw.
- A3 ✅ verified: top-level `openapi` list (8 cases, keys `name`/`spec`/`expect`) consumed by
  `gen-openapi/src/cases.spec.ts:8` and `gen_openapi` `test_cases.py:11`; the 22 `cases` are DTO-only;
  no floats in the OpenAPI subset. Golden `go/entity/testdata/html-escape.json` = 227 bytes, no trailing newline.
- A4 ⏳ unverified: nimble does not need a lockfile committed for a zero-dependency package — verify
  with `nimble test` on the real package in the plan's first task.

## Decisions (batch-grill, 2026-09-13)

- Scope → user chose **everything**; split into I-007…I-010, this is the first.
- API shape → **pragma macros** (user: "robust and clean like Python @decorator"); Go's builder was
  a Go-only constraint.
- Async runtime for later lanes → stdlib `asyncdispatch` (default, not asked) — the maintained Redis
  and RabbitMQ clients use it.
- Package layout → one nimble package, submodules (default, not asked) — mirrors Go; nimble
  packages are heavyweight to multiply.
- OpenAPI in this feature → yes (user scope); it is the same ~360 LOC port F-005 skipped.

## Appendix — audit trail
- 2026-09-13 self-grill-audit: verdict safe-with-fixes. Corrected: ci-contracts has one `entity-parity`
  job, not two (H1); dropped `registeredSpecs()` — Node's registry is not enumerable (H2); nested
  object types must be declared in the same `restful` block (H3); renamed API to "block macro + field
  pragmas", not experimental pragma-on-type (M4); `Option[int]` min/max on float fields made explicit
  (M5); ci-nim.yml runs check/test only, parity stays in ci-contracts (M6); version is a moving
  target, gen-openapi = 6 files / 359 LOC (L7); blast radius + ci-node.yml:106 allowlist noted (L8);
  A1–A3 marked verified, A4 still open. Open R0: none.
- Off-goal, filed only: `python/uv.lock` is gitignored (`.gitignore:16`) yet `ci-node.yml:106`
  git-adds it and `bump-version.sh:45` refreshes it.

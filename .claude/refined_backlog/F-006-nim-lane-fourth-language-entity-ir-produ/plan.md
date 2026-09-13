# Nim lane: fourth language — entity IR producer + OpenAPI emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nim/` — a zero-dependency Nim 2.2.12 package that declares entities with a `restful` block macro + field pragmas, emits the EntitySpec IR byte-identical to `contracts/fixtures/entity-spec.valid-user.json`, ports gen-openapi byte-identical to `contracts/fixtures/openapi.valid-user.json`, and is wired into the parity scripts, version lockstep, and CI.

**Architecture:** A typed IR (`entity/types.nim`, mirrors `types.ts`) is built at **compile time** by the `restful` macro into a `const`; `validateEntitySpec` runs inside that `const` block so every `validate.ts` rule is a compile error. `entity/emit.nim` turns the IR into `JsonNode` with the same omit rules as Node, and `entity/canonical.nim` serialises with code-point-sorted keys (byte-identical to `canonical.ts`). `gen_openapi.nim` is a line-by-line port of `node/packages/gen-openapi/src` producing a `JsonNode` through the same canonical emitter. Layering: `gen_openapi → entity → stdlib`.

**Tech Stack:** Nim 2.2.12 + nimble 0.24 (stdlib only: `std/macros`, `std/json`, `std/options`, `std/unittest`), bash, GitHub Actions (`jiro4989/setup-nim-action@v2`).

**Spec:** `.claude/refined_backlog/F-006-nim-lane-fourth-language-entity-ir-produ/spec.md` (audited 2026-09-13, safe-with-fixes; see its appendix).

## Global Constraints

- **Toolchain:** Nim **2.2.12** / nimble 0.24.1 at `~/.nimble/bin` — run `export PATH=$HOME/.nimble/bin:$PATH` before ANY `nim`/`nimble` command (not on login PATH; do NOT use brew/choosenim — see memory `nim-toolchain-install`). CI pins the same version.
- **Zero dependencies:** the `.nimble` has only `requires "nim >= 2.2.12"`. Never commit `nimble.lock` (verified: `nimble test` creates none).
- **No change under `contracts/`.** `specVersion` is `"1.2.0"`.
- **Byte identity is the acceptance test:** IR == `contracts/fixtures/entity-spec.valid-user.json`; OpenAPI == `contracts/fixtures/openapi.valid-user.json`; all 8 `openapi` cases in `contracts/fixtures/entity-spec.cases.json` pass.
- **Layering:** `gen_openapi` imports `entity`; `entity/*` imports only stdlib. Never import Node/Python/Go artefacts.
- **Version:** `nim/server_decorator.nimble` `version` must equal the lockstep version. It is `2.0.4` today but `ci-node.yml` auto-bumps on every push to `main` — read it at task time: `node -p "require('./node/packages/core/package.json').version"`.
- **Nested `obj` types must be declared inside the same `restful` block**; the last type in the block is the entity.
- **`min`/`max` are `Option[int]` on every field type, including `float`** (fixture: `score` is `float` with `min: 0`). The IR never contains a Nim float.
- **Everything below was built and run in a scratchpad on 2026-09-13** (Nim 2.2.12): 6 test modules / 32 tests green, both fixtures byte-identical, `nimble check` valid. Copy the code verbatim. If a step fails, suspect PATH / cwd / a copy error before changing the code.
- **Where to work:** the F-006 worktree (`.claude/worktrees/F-006-nim-lane-fourth-language-entity-ir-produ`, branch `feat/F-006`). Run `scripts/*.sh` from the repo root; run `nim`/`nimble` from `nim/`.
- **Commits:** one per task, new commits only (never `--amend`), trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
nim/
  server_decorator.nimble                  # version (lockstep), srcDir = "src", requires nim only
  src/server_decorator.nim                 # umbrella: re-exports entity + gen_openapi
  src/server_decorator/entity.nim          # `restful` block macro; re-exports entity/*
  src/server_decorator/entity/types.nim    # EntitySpec / FieldSpec / ActionSpec / Security* objects
  src/server_decorator/entity/canonical.nim# canonicalJson(JsonNode): code-point key sort, raw UTF-8
  src/server_decorator/entity/emit.nim     # toJson(EntitySpec) with Node's omit rules; canonical(spec)
  src/server_decorator/entity/parse.nim    # parseEntitySpec(JsonNode) — inverse, used by t_cases
  src/server_decorator/entity/validate.nim # validate.ts port (raises ValueError → compile error)
  src/server_decorator/gen_openapi.nim     # map-field + components + paths + document + patterns port
  examples/config.nims                     # --path to ../src
  examples/user.nim                        # the fixture entity (parity input)
  examples/emit_fixture.nim                # stdout: canonical IR
  examples/emit_openapi.nim                # stdout: canonical OpenAPI (version from contracts/VERSION)
  tests/config.nims                        # --path to ../src
  tests/t_canonical.nim  tests/t_validate.nim  tests/t_entity.nim  tests/t_openapi.nim  tests/t_cases.nim
  tests/t_compile_errors.nim  tests/negative/{expected.txt,typo_pragma,reserved_name,outside_nested_type,format_and_pattern}.nim
  README.md
```
Modified: `scripts/check-entity-parity.sh`, `scripts/check-openapi-parity.sh`, `scripts/check-versions.sh`, `scripts/bump-version.sh`, `.github/workflows/ci-contracts.yml`, `.github/workflows/ci-node.yml` (line 106), `.gitignore`, `CLAUDE.md`. New: `.github/workflows/ci-nim.yml`.

Every Nim command below assumes:
```bash
export PATH=$HOME/.nimble/bin:$PATH
cd /Users/pasitnusso/workspace/repos/node-server-decorator/.claude/worktrees/F-006-nim-lane-fourth-language-entity-ir-produ/nim
```

---

### Task 1: Package skeleton, IR types, canonical emitter, emit + parse

**Files:**
- Create: `nim/server_decorator.nimble`, `nim/src/server_decorator/entity/types.nim`, `nim/src/server_decorator/entity/canonical.nim`, `nim/src/server_decorator/entity/emit.nim`, `nim/src/server_decorator/entity/parse.nim`, `nim/tests/config.nims`
- Test: `nim/tests/t_canonical.nim`

**Interfaces:**
- Produces: `types.nim` — `FieldType` enum (`ftStr`…`ftObj`, `$ft` gives the wire string), objects `FieldSpec`, `ActionSpec`, `SecurityScheme`, `ScopeEntry = tuple[key: string, scopes: seq[string]]`, `SecuritySpec`, `EntitySpec`, `const SpecVersion = "1.2.0"`. `canonical.nim` — `canonicalJson*(n: JsonNode): string`. `emit.nim` — `toJson*(e: EntitySpec): JsonNode`, `canonical*(e: EntitySpec): string`. `parse.nim` — `parseEntitySpec*(n: JsonNode): EntitySpec`.

- [ ] **Step 1: Create the manifest** (set `version` to the current lockstep version — `node -p "require('./node/packages/core/package.json').version"` from repo root)

`nim/server_decorator.nimble`:
```nim
version       = "2.0.4"
author        = "montionugera"
description   = "server-decorator: entity IR + OpenAPI (Nim lane)"
license       = "MIT"
srcDir        = "src"
requires "nim >= 2.2.12"
```

- [ ] **Step 2: Create `nim/tests/config.nims` and `nim/examples/config.nims`** (identical content)

```nim
switch("path", "$projectDir/../src")
switch("hints", "off")
```

- [ ] **Step 3: Write the failing test** `nim/tests/t_canonical.nim`

```nim
## Canonical JSON: sorted keys by code point, no whitespace, raw non-ASCII / <>& / U+2028 (entity-spec-canonical.md).
import std/[unittest, json, os]
import server_decorator/entity/canonical

let root = currentSourcePath().parentDir / "../.."

suite "canonical JSON":
  test "sorts keys by Unicode code point at every level":
    check canonicalJson(parseJson("""{"b":1,"a":{"z":[{"y":1,"x":2}],"é":3,"Z":4}}""")) ==
      """{"a":{"Z":4,"z":[{"x":2,"y":1}],"é":3},"b":1}"""
  test "no whitespace, flags and numbers verbatim":
    check canonicalJson(%*{"k": [true, false, 0, 7, "s"]}) == """{"k":[true,false,0,7,"s"]}"""
  test "leaves non-ASCII, <>& and U+2028 raw (no \\uXXXX)":
    check canonicalJson(%"a <b> & c é  ") == "\"a <b> & c é  \""
  test "control chars: short forms + LOWERCASE \\u00xx like JSON.stringify (not escapeJson's \\u001F)":
    check canonicalJson(%"\x1f\x0e\x01\b\t\n\r\f\"\\/") == "\"\\u001f\\u000e\\u0001\\b\\t\\n\\r\\f\\\"\\\\/\""
  for f in ["contracts/fixtures/entity-spec.valid-user.json", "contracts/fixtures/openapi.valid-user.json",
            "go/entity/testdata/html-escape.json"]:
    test "round-trips " & f & " byte-identically":
      let raw = readFile(root / f)
      check canonicalJson(parseJson(raw)) == raw
```

- [ ] **Step 4: Run it to verify it fails**

Run: `nim r --hints:off tests/t_canonical.nim`
Expected: compile error `cannot open file: server_decorator/entity/canonical`

- [ ] **Step 5: Create the four source modules**

`nim/src/server_decorator/entity/types.nim`:
```nim
## Typed EntitySpec IR — mirrors node/packages/entity/src/types.ts (specVersion 1.2.0).
import std/options

type
  FieldType* = enum
    ftStr = "str", ftInt = "int", ftFloat = "float", ftBool = "bool", ftDatetime = "datetime",
    ftEnum = "enum", ftRef = "ref", ftList = "list", ftObj = "obj"

  FieldSpec* = object
    name*: string
    `type`*: FieldType
    description*: Option[string]
    role*: Option[string]          # only "id"
    format*: Option[string]        # email | uuid | uri
    `enum`*: seq[string]           # emitted only for ftEnum
    min*, max*: Option[int]        # Option so an explicit 0 survives (fixture: loginCount.min = 0)
    pattern*: Option[string]
    optional*, nullable*, readonly*, writeonly*, filterable*: bool   # emitted only when true
    item*: seq[FieldSpec]          # 0 or 1 element (Option[FieldSpec] is not allowed on a recursive object)
    `ref`*: Option[string]
    fields*: seq[FieldSpec]        # ftObj members

  ActionSpec* = object
    name*: string
    description*: Option[string]
    stateField*, `from`*, to*: Option[string]
    input*: seq[FieldSpec]         # emitted only when non-empty
    transactional*: Option[bool]   # emitted only when some(false)

  SecurityScheme* = object
    name*: string
    `type`*: string                # http | apiKey
    scheme*: Option[string]        # bearer | basic
    bearerFormat*: Option[string]
    `in`*: Option[string]          # header | query | cookie
    paramName*: Option[string]

  ScopeEntry* = tuple[key: string, scopes: seq[string]]

  SecuritySpec* = object
    schemes*: seq[SecurityScheme]
    ops*: seq[ScopeEntry]          # emitted only when non-empty
    actions*: seq[ScopeEntry]      # emitted only when non-empty

  EntitySpec* = object
    specVersion*: string           # always "1.2.0"
    entity*, path*: string
    transports*: seq[string]       # rest | rpc | sse | ws
    ops*: seq[string]              # list | get | create | update | delete
    pagination*: string            # offset | cursor
    description*: Option[string]
    tags*: Option[seq[string]]     # some(@[]) emits "tags":[] like Node
    security*: Option[SecuritySpec]
    fields*: seq[FieldSpec]
    actions*: seq[ActionSpec]      # emitted only when non-empty

const SpecVersion* = "1.2.0"
```

`nim/src/server_decorator/entity/canonical.nim`:
```nim
import std/[json, algorithm, unicode, strutils]

# Compare by Unicode code point (== UTF-8 byte order), like Python sorted() / canonical.ts.
proc cmpCodePoints(a, b: string): int =
  let ra = a.toRunes; let rb = b.toRunes
  for i in 0 ..< min(ra.len, rb.len):
    let d = int(ra[i]) - int(rb[i])
    if d != 0: return d
  ra.len - rb.len

proc escapeString(s: string): string =
  ## JSON.stringify-compatible escaping: short forms for " \ \b \f \n \r \t, LOWERCASE
  ## \u00xx for the other control chars, everything else (non-ASCII, <>&, U+2028) raw.
  ## Not std/json.escapeJson: it emits UPPERCASE hex (\u001F), breaking byte parity with
  ## Node/Python/Go for 0x0E-0x1F (F-006 plan audit, HIGH-1).
  result = newStringOfCap(s.len + 2)
  result.add '"'
  for c in s:
    case c
    of '"': result.add "\\\""
    of '\\': result.add "\\\\"
    of '\b': result.add "\\b"
    of '\f': result.add "\\f"
    of '\n': result.add "\\n"
    of '\r': result.add "\\r"
    of '\t': result.add "\\t"
    of '\0'..'\7', '\11', '\14'..'\31': result.add "\\u00" & toHex(ord(c), 2).toLowerAscii
    else: result.add c
  result.add '"'

proc canonicalJson*(n: JsonNode): string =
  case n.kind
  of JObject:
    var keys: seq[string] = @[]
    for k in n.keys: keys.add k
    keys.sort(cmpCodePoints)
    result = "{"
    for i, k in keys:
      if i > 0: result.add ","
      result.add escapeString(k); result.add ":"; result.add canonicalJson(n[k])
    result.add "}"
  of JArray:
    result = "["
    for i, e in n.elems:
      if i > 0: result.add ","
      result.add canonicalJson(e)
    result.add "]"
  of JString: result = escapeString(n.str)
  of JInt: result = $n.num
  of JFloat: result = $n.fnum
  of JBool: result = (if n.bval: "true" else: "false")
  of JNull: result = "null"
```

`nim/src/server_decorator/entity/emit.nim`:
```nim
## EntitySpec → JsonNode with the same omit rules as node/packages/entity (restful.ts, fields.ts, action.ts).
import std/[json, options]
import ./types, ./canonical

proc putOpt(n: JsonNode, key: string, v: Option[string]) =
  if v.isSome: n[key] = %v.get
proc putOpt(n: JsonNode, key: string, v: Option[int]) =
  if v.isSome: n[key] = %v.get

proc toJson*(f: FieldSpec): JsonNode =
  result = newJObject()
  result["name"] = %f.name
  result["type"] = %($f.`type`)
  result.putOpt("description", f.description)
  result.putOpt("role", f.role)
  result.putOpt("format", f.format)
  if f.`type` == ftEnum: result["enum"] = %f.`enum`
  result.putOpt("min", f.min)
  result.putOpt("max", f.max)
  result.putOpt("pattern", f.pattern)
  for (k, v) in [("optional", f.optional), ("nullable", f.nullable), ("readonly", f.readonly),
                 ("writeonly", f.writeonly), ("filterable", f.filterable)]:
    if v: result[k] = %true
  if f.item.len > 0: result["item"] = toJson(f.item[0])
  result.putOpt("ref", f.`ref`)
  if f.`type` == ftObj:
    var arr = newJArray()
    for m in f.fields: arr.add toJson(m)
    result["fields"] = arr

proc toJson*(a: ActionSpec): JsonNode =
  result = newJObject()
  result["name"] = %a.name
  result.putOpt("description", a.description)
  result.putOpt("stateField", a.stateField)
  result.putOpt("from", a.`from`)
  result.putOpt("to", a.to)
  if a.input.len > 0:
    var arr = newJArray()
    for f in a.input: arr.add toJson(f)
    result["input"] = arr
  if a.transactional.isSome and not a.transactional.get: result["transactional"] = %false

proc toJson*(s: SecurityScheme): JsonNode =
  result = newJObject()
  result["name"] = %s.name
  result["type"] = %s.`type`
  result.putOpt("scheme", s.scheme)
  result.putOpt("bearerFormat", s.bearerFormat)
  result.putOpt("in", s.`in`)
  result.putOpt("paramName", s.paramName)

proc scopeMap(entries: seq[ScopeEntry]): JsonNode =
  result = newJObject()
  for (k, scopes) in entries: result[k] = %scopes

proc toJson*(s: SecuritySpec): JsonNode =
  result = newJObject()
  var arr = newJArray()
  for sc in s.schemes: arr.add toJson(sc)
  result["schemes"] = arr
  if s.ops.len > 0: result["ops"] = scopeMap(s.ops)
  if s.actions.len > 0: result["actions"] = scopeMap(s.actions)

proc toJson*(e: EntitySpec): JsonNode =
  result = newJObject()
  result["specVersion"] = %e.specVersion
  result["entity"] = %e.entity
  result["path"] = %e.path
  result["transports"] = %e.transports
  result["ops"] = %e.ops
  result["pagination"] = %e.pagination
  result.putOpt("description", e.description)
  if e.tags.isSome: result["tags"] = %e.tags.get
  if e.security.isSome: result["security"] = toJson(e.security.get)
  var fs = newJArray()
  for f in e.fields: fs.add toJson(f)
  result["fields"] = fs
  if e.actions.len > 0:
    var acts = newJArray()
    for a in e.actions: acts.add toJson(a)
    result["actions"] = acts

proc canonical*(e: EntitySpec): string = canonicalJson(toJson(e))
```

`nim/src/server_decorator/entity/parse.nim`:
```nim
## JsonNode → EntitySpec (inverse of emit.nim). Used by the cases.json test runner and by consumers
## that receive IR over the wire.
import std/[json, options]
import ./types

proc optStr(n: JsonNode, k: string): Option[string] =
  if n.hasKey(k): some(n[k].getStr) else: none(string)
proc optInt(n: JsonNode, k: string): Option[int] =
  if n.hasKey(k): some(n[k].getInt) else: none(int)
proc flag(n: JsonNode, k: string): bool = n.hasKey(k) and n[k].getBool

proc parseFieldType*(s: string): FieldType =
  for ft in FieldType:
    if $ft == s: return ft
  raise newException(ValueError, "unknown field type: " & s)

proc parseField*(n: JsonNode): FieldSpec =
  result = FieldSpec(name: n["name"].getStr, `type`: parseFieldType(n["type"].getStr),
    description: optStr(n, "description"), role: optStr(n, "role"), format: optStr(n, "format"),
    min: optInt(n, "min"), max: optInt(n, "max"), pattern: optStr(n, "pattern"),
    optional: flag(n, "optional"), nullable: flag(n, "nullable"), readonly: flag(n, "readonly"),
    writeonly: flag(n, "writeonly"), filterable: flag(n, "filterable"), `ref`: optStr(n, "ref"))
  if n.hasKey("enum"):
    for e in n["enum"]: result.`enum`.add e.getStr
  if n.hasKey("item"): result.item = @[parseField(n["item"])]
  if n.hasKey("fields"):
    for f in n["fields"]: result.fields.add parseField(f)

proc parseAction*(n: JsonNode): ActionSpec =
  result = ActionSpec(name: n["name"].getStr, description: optStr(n, "description"),
    stateField: optStr(n, "stateField"), `from`: optStr(n, "from"), to: optStr(n, "to"))
  if n.hasKey("input"):
    for f in n["input"]: result.input.add parseField(f)
  if n.hasKey("transactional"): result.transactional = some(n["transactional"].getBool)

proc parseScopes(n: JsonNode): seq[ScopeEntry] =
  for k, v in n.pairs:
    var scopes: seq[string]
    for s in v: scopes.add s.getStr
    result.add (k, scopes)

proc parseSecurity*(n: JsonNode): SecuritySpec =
  for s in n["schemes"]:
    result.schemes.add SecurityScheme(name: s["name"].getStr, `type`: s["type"].getStr,
      scheme: optStr(s, "scheme"), bearerFormat: optStr(s, "bearerFormat"),
      `in`: optStr(s, "in"), paramName: optStr(s, "paramName"))
  if n.hasKey("ops"): result.ops = parseScopes(n["ops"])
  if n.hasKey("actions"): result.actions = parseScopes(n["actions"])

proc strs(n: JsonNode): seq[string] =
  for e in n: result.add e.getStr

proc parseEntitySpec*(n: JsonNode): EntitySpec =
  result = EntitySpec(specVersion: n["specVersion"].getStr, entity: n["entity"].getStr,
    path: n["path"].getStr, transports: strs(n["transports"]), ops: strs(n["ops"]),
    pagination: n["pagination"].getStr, description: optStr(n, "description"))
  if n.hasKey("tags"): result.tags = some(strs(n["tags"]))
  if n.hasKey("security"): result.security = some(parseSecurity(n["security"]))
  for f in n["fields"]: result.fields.add parseField(f)
  if n.hasKey("actions"):
    for a in n["actions"]: result.actions.add parseAction(a)
```

- [ ] **Step 6: Run the test and the manifest check**

Run: `nim r --hints:off tests/t_canonical.nim && nimble check`
Expected: 6 × `[OK]` (three fixture round-trips byte-identical, incl. `go/entity/testdata/html-escape.json`), then `Success: The package "server_decorator" is valid.`

- [ ] **Step 7: Commit**

```bash
git add nim/server_decorator.nimble nim/src nim/tests
git commit -m "feat(nim): entity IR types, canonical JSON emitter, emit/parse (F-006)"
```

- [ ] **Step 8: Phase gate** — shared with Task 2 (same subsystem, small diffs): run after Task 2 Step 5.

---

### Task 2: `validate.nim` — port of `validate.ts`

**Files:**
- Create: `nim/src/server_decorator/entity/validate.nim`
- Test: `nim/tests/t_validate.nim`

**Interfaces:**
- Consumes: `types.nim` objects.
- Produces: `validateEntitySpec*(spec: EntitySpec)` (raises `ValueError` with the exact `validate.ts` messages), `validateField*`, `validateSecurity*`, `hasBackreference*(pattern: string): bool`, `ReservedWireNames*`.

- [ ] **Step 1: Write the failing test** `nim/tests/t_validate.nim`

```nim
import std/[unittest, options]
import server_decorator/entity/types, server_decorator/entity/validate

proc minimal(fields: seq[FieldSpec]): EntitySpec =
  EntitySpec(specVersion: SpecVersion, entity: "T", path: "t", transports: @["rest"], ops: @["get"],
             pagination: "offset", fields: fields)

suite "validate (port of validate.ts)":
  test "reserved wire name": 
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "model_dump", `type`: ftStr)]))
  test "format and pattern are mutually exclusive":
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "e", `type`: ftStr, format: some("email"), pattern: some("^x$"))]))
  test "lookaround and backreference patterns are rejected; escaped backslash-digit is not":
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "p", `type`: ftStr, pattern: some("^(?=a)"))]))
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "p", `type`: ftStr, pattern: some("(a)\\1"))]))
    validateEntitySpec(minimal(@[FieldSpec(name: "p", `type`: ftStr, pattern: some("a\\\\1"))]))
    check hasBackreference("(a)\\1") and not hasBackreference("a\\\\1") and not hasBackreference("\\0")
  test "empty enum, empty transports, empty ops":
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "s", `type`: ftEnum)]))
    var s = minimal(@[]); s.transports = @[]
    expect ValueError: validateEntitySpec(s)
    var o = minimal(@[]); o.ops = @[]
    expect ValueError: validateEntitySpec(o)
  test "security rules":
    var s = minimal(@[])
    s.security = some(SecuritySpec(schemes: @[]))
    expect ValueError: validateEntitySpec(s)
    s.security = some(SecuritySpec(schemes: @[SecurityScheme(name: "k", `type`: "apiKey")]))
    expect ValueError: validateEntitySpec(s)
    s.security = some(SecuritySpec(schemes: @[SecurityScheme(name: "b", `type`: "http", scheme: some("bearer"))],
                                   ops: @[("create", @["x"])]))
    expect ValueError: validateEntitySpec(s)          # create not in ops [get]
    s.security.get.ops = @[]; s.security.get.actions = @[("nope", @["x"])]
    expect ValueError: validateEntitySpec(s)          # undeclared action
  test "nested item/fields are validated recursively":
    expect ValueError: validateEntitySpec(minimal(@[FieldSpec(name: "l", `type`: ftList,
      item: @[FieldSpec(name: "l", `type`: ftObj, fields: @[FieldSpec(name: "json", `type`: ftStr)])])]))
```

- [ ] **Step 2: Run to verify it fails** — `nim r --hints:off tests/t_validate.nim` → `cannot open file: server_decorator/entity/validate`

- [ ] **Step 3: Create `nim/src/server_decorator/entity/validate.nim`**

```nim
## Port of node/packages/entity/src/validate.ts. Raises ValueError; the `restful` macro runs it
## inside a `const` block, so a violation is a compile error carrying the same message.
import std/[options, strutils, sequtils]
import ./types

# Public pydantic.BaseModel attribute names (pydantic v2) — see contracts/rules/entity-spec-validation.md.
const ReservedWireNames* = ["construct", "copy", "dict", "from_orm", "json", "model_computed_fields",
  "model_config", "model_construct", "model_copy", "model_dump", "model_dump_json", "model_extra",
  "model_fields", "model_fields_set", "model_json_schema", "model_parametrized_name", "model_post_init",
  "model_rebuild", "model_validate", "model_validate_json", "model_validate_strings", "parse_file",
  "parse_obj", "parse_raw", "schema", "schema_json", "update_forward_refs", "validate"]

const LookaroundMarkers = ["(?=", "(?!", "(?<=", "(?<!"]

proc fail(msg: string) = raise newException(ValueError, msg)

# Odd run of `\` before a digit 1-9 = backreference (`\1`); even run = escaped backslashes.
proc hasBackreference*(pattern: string): bool =
  for i, c in pattern:
    if c in '1'..'9':
      var backslashes = 0
      var j = i - 1
      while j >= 0 and pattern[j] == '\\':
        inc backslashes; dec j
      if backslashes mod 2 == 1: return true
  false

proc assertPortablePattern(pattern: Option[string], label: string) =
  if pattern.isNone: return
  let p = pattern.get
  for m in LookaroundMarkers:
    if m in p:
      fail(label & ": pattern \"" & p & "\" is not RE2/rust-regex compatible (contains lookaround \"" & m &
           "\") — see contracts/rules/entity-spec-validation.md")
  if hasBackreference(p):
    fail(label & ": pattern \"" & p & "\" is not RE2/rust-regex compatible (contains a backreference) — see contracts/rules/entity-spec-validation.md")

proc validateField*(f: FieldSpec, path: string) =
  let label = "field \"" & path & "\""
  if f.name in ReservedWireNames:
    fail(label & ": wire name \"" & f.name & "\" is reserved (shadows a pydantic BaseModel attribute)")
  if f.format.isSome and f.pattern.isSome: fail(label & ": format and pattern are mutually exclusive")
  assertPortablePattern(f.pattern, label)
  if f.`type` == ftEnum and f.`enum`.len == 0: fail(label & ": enum must have at least one value")
  # min/max are Option[int] by construction — the "must be integers" check is the type system's.
  if f.item.len > 0: validateField(f.item[0], path & ".item")
  for nested in f.fields: validateField(nested, path & "." & nested.name)

proc validateSecurity*(security: Option[SecuritySpec], ops: seq[string], actionNames: seq[string], entity: string) =
  if security.isNone: return
  let s = security.get
  if s.schemes.len == 0: fail(entity & ": security.schemes must not be empty")
  for sc in s.schemes:
    if sc.`type` notin ["http", "apiKey"]: fail(entity & ": scheme \"" & sc.name & "\": type must be \"http\" or \"apiKey\"")
    if sc.`type` == "http" and sc.scheme.isNone: fail(entity & ": scheme \"" & sc.name & "\": http requires \"scheme\"")
    if sc.`type` == "apiKey" and (sc.`in`.isNone or sc.paramName.isNone):
      fail(entity & ": scheme \"" & sc.name & "\": apiKey requires \"in\" and \"paramName\"")
  for (op, _) in s.ops:
    if op notin ops: fail(entity & ": security.ops." & op & " is not declared in ops")
  for (name, _) in s.actions:
    if name notin actionNames: fail(entity & ": security.actions." & name & " is not a declared action")

proc validateEntitySpec*(spec: EntitySpec) =
  if spec.transports.len == 0: fail(spec.entity & ": transports must not be empty")
  if spec.ops.len == 0: fail(spec.entity & ": ops must not be empty")
  for f in spec.fields: validateField(f, f.name)
  for a in spec.actions:
    for f in a.input: validateField(f, a.name & "." & f.name)
  validateSecurity(spec.security, spec.ops, spec.actions.mapIt(it.name), spec.entity)
```

- [ ] **Step 4: Run** — `nim r --hints:off tests/t_validate.nim` → 6 × `[OK]`.

- [ ] **Step 5: Commit**

```bash
git add nim/src/server_decorator/entity/validate.nim nim/tests/t_validate.nim
git commit -m "feat(nim): port validate.ts (reserved names, portable patterns, security rules)"
```

- [ ] **Step 6: Phase gate (Tasks 1+2)** (rule 7): `nimble test` green → independent review of `git diff release/1.2 -- nim/` (`code-reviewer`, `model: sonnet`; check omit rules against `restful.ts`/`fields.ts`/`action.ts` and messages against `validate.ts`) → `/simplify` → re-run `nimble test`.

---

### Task 3: The `restful` block macro, the fixture entity, compile-error harness

**Files:**
- Create: `nim/src/server_decorator/entity.nim`, `nim/examples/config.nims` (same as tests/config.nims), `nim/examples/user.nim`, `nim/examples/emit_fixture.nim`, `nim/tests/negative/expected.txt`, `nim/tests/negative/typo_pragma.nim`, `nim/tests/negative/reserved_name.nim`, `nim/tests/negative/outside_nested_type.nim`, `nim/tests/negative/format_and_pattern.nim`
- Test: `nim/tests/t_entity.nim`, `nim/tests/t_compile_errors.nim`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `macro restful*(path: string, args: varargs[untyped])` — options `description = "…"`, `tags = [..]`, `transports = [rest, rpc, sse, ws]`, `ops = [list, get, create, update, delete]`, `pagination = offset|cursor`, `security = SecuritySpec(...)`; body = one `type` section (last type = entity; earlier types = nested `obj` types) + `action "name"[, description = "…"][, transactional = false]:` blocks with `transition "field", "from", "to"` and `input:` field lines. Field pragmas: flags `optional nullable readonly writeonly filterable`; `description: "…"`, `role: "id"`, `format: "email"|"uuid"|"uri"`, `pattern: "…"`, `refTo: "Entity"`, `min: N`, `max: N` (integer literals), `enumOf: ["a", "b"]`. Field types: `string int float bool DateTime seq[T] <NestedObject>`. Generates the plain Nim type(s) plus `template entitySpec*(_: typedesc[Entity]): EntitySpec`.

- [ ] **Step 1: Write the failing tests**

`nim/tests/t_entity.nim`:
```nim
## The `restful` macro: fixture parity, defaults, list item naming, explicit zero.
import std/[unittest, json, os, times]
import server_decorator/entity
import ../examples/user

let root = currentSourcePath().parentDir / "../.."

restful "minimals":
  type Minimal = object
    id {.role: "id", readonly.}: string
    matrix: seq[seq[int]]
    zero {.min: 0.}: int

suite "restful macro":
  test "User == contracts/fixtures/entity-spec.valid-user.json (byte-identical)":
    check canonical(entitySpec(User)) == readFile(root / "contracts/fixtures/entity-spec.valid-user.json")
  test "the emitted Nim type is a plain object":
    let u = User(id: "1", email: "a@b.co", name: "Ann", loginCount: 2, birthday: now())
    check u.name == "Ann"
  test "defaults: transports [rest], all five ops, offset; no description/tags/security/actions keys":
    let j = toJson(entitySpec(Minimal))
    check j["transports"] == %*["rest"]
    check j["ops"] == %*["list", "get", "create", "update", "delete"]
    check j["pagination"].getStr == "offset"
    for k in ["description", "tags", "security", "actions"]: check not j.hasKey(k)
  test "list-of-list carries the field name into item at every level (fields.ts injectListItemNames)":
    let m = toJson(entitySpec(Minimal))["fields"][1]
    check m["item"]["name"].getStr == "matrix"
    check m["item"]["item"]["name"].getStr == "matrix"
    check m["item"]["item"]["type"].getStr == "int"
  test "an explicit min: 0 survives (Option[int], not a falsy default)":
    check toJson(entitySpec(Minimal))["fields"][2]["min"] == %0
```

`nim/tests/t_compile_errors.nim`:
```nim
## Each tests/negative/<file>.nim must FAIL `nim check` with the message in expected.txt (AC3).
import std/[unittest, osproc, os, strutils]
let dir = currentSourcePath().parentDir / "negative"
suite "compile-time rejections":
  for line in readFile(dir / "expected.txt").strip.splitLines:
    let (file, expected) = (line.split('|')[0], line.split('|')[1])
    test file:
      let (output, code) = execCmdEx("nim check --hints:off --path:" & quoteShell(dir / "../../src") & " " & quoteShell(dir / file))
      check code != 0
      check expected in output
```

`nim/tests/negative/expected.txt` (format `file|substring of the expected compiler error`):
```
typo_pragma.nim|unknown field pragma 'rolee' on field 'id'
reserved_name.nim|field "json": wire name "json" is reserved
outside_nested_type.nim|nested object types must be declared inside the same `restful` block
format_and_pattern.nim|field "email": format and pattern are mutually exclusive
```

`nim/tests/negative/typo_pragma.nim`:
```nim
import server_decorator/entity
restful "things":
  type Thing = object
    id {.rolee: "id".}: string
```
`nim/tests/negative/reserved_name.nim`:
```nim
import server_decorator/entity
restful "things":
  type Thing = object
    id {.role: "id", readonly.}: string
    json: string
```
`nim/tests/negative/outside_nested_type.nim`:
```nim
import server_decorator/entity
type Addr = object
  city: string
restful "things":
  type Thing = object
    id {.role: "id", readonly.}: string
    home: Addr
```
`nim/tests/negative/format_and_pattern.nim`:
```nim
import server_decorator/entity
restful "things":
  type Thing = object
    id {.role: "id", readonly.}: string
    email {.format: "email", pattern: "^x$".}: string
```

- [ ] **Step 2: Run to verify they fail** — `nim r --hints:off tests/t_entity.nim` → `cannot open file: server_decorator/entity`.

- [ ] **Step 3: Create the macro module** `nim/src/server_decorator/entity.nim`

```nim
## `restful` block macro + field pragmas — the Nim analogue of @Restful/@restful.
import std/[macros, options, tables]
import ./entity/types, ./entity/emit, ./entity/canonical, ./entity/validate
export types, emit, canonical, validate, options

const Flags = ["optional", "nullable", "readonly", "writeonly", "filterable"]
const StrPragmas = ["description", "role", "format", "pattern", "refTo"]

proc pName(p: NimNode): string =
  case p.kind
  of nnkIdent, nnkSym: p.strVal
  of nnkExprColonExpr, nnkCall, nnkExprEqExpr: p[0].strVal
  else: error("unsupported pragma syntax: " & p.repr, p)

proc strLit(n: NimNode, what: string): NimNode =
  if n.kind notin {nnkStrLit, nnkTripleStrLit, nnkRStrLit}: error(what & " must be a string literal", n)
  n

proc someOf(n: NimNode): NimNode = newCall(ident"some", n)

# Build `FieldSpec(...)` for one `name {.pragmas.}: Type` declaration.
proc fieldCstr(nameNode, typeNode: NimNode, pragmas: NimNode, nested: Table[string, NimNode]): NimNode

proc typeToKind(t: NimNode, name: string, nested: Table[string, NimNode],
                cstr: var seq[NimNode]): string =
  ## Returns the FieldType enum name and appends item/fields entries to `cstr`.
  case t.kind
  of nnkIdent:
    case t.strVal
    of "string": "ftStr"
    of "int", "int64", "int32": "ftInt"
    of "float", "float64": "ftFloat"
    of "bool": "ftBool"
    of "DateTime", "Time": "ftDatetime"
    else:
      if t.strVal in nested:
        cstr.add newColonExpr(ident"fields", nested[t.strVal].copyNimTree)
        "ftObj"
      else:
        error("field '" & name & "': unknown type '" & t.strVal &
              "' — nested object types must be declared inside the same `restful` block", t)
  of nnkBracketExpr:
    if t[0].kind == nnkIdent and t[0].strVal == "seq":
      # list: item carries the SAME name at every nesting level (fields.ts injectListItemNames)
      let item = fieldCstr(ident(name), t[1], newEmptyNode(), nested)
      cstr.add newColonExpr(ident"item", nnkPrefix.newTree(ident"@", nnkBracket.newTree(item)))
      "ftList"
    else: error("field '" & name & "': unsupported type " & t.repr, t)
  else: error("field '" & name & "': unsupported type " & t.repr, t)

proc fieldCstr(nameNode, typeNode: NimNode, pragmas: NimNode, nested: Table[string, NimNode]): NimNode =
  let name = nameNode.strVal
  var cstr: seq[NimNode] = @[newColonExpr(ident"name", newLit(name))]
  var kind = typeToKind(typeNode, name, nested, cstr)
  var enumVals: NimNode = nil
  if pragmas.kind != nnkEmpty:
    for p in pragmas:
      let n = pName(p)
      if n in Flags:
        if p.kind != nnkIdent: error("field '" & name & "': flag '" & n & "' takes no value", p)
        cstr.add newColonExpr(ident(n), newLit(true))
      elif n in StrPragmas:
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr}: error("field '" & name & "': '" & n & "' needs a string value", p)
        let v = strLit(p[1], "field '" & name & "': " & n)
        if n == "refTo":
          kind = "ftRef"; cstr.add newColonExpr(ident"ref", someOf(v))
        else:
          cstr.add newColonExpr(ident(n), someOf(v))
      elif n in ["min", "max"]:
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr} or p[1].kind != nnkIntLit:
          error("field '" & name & "': '" & n & "' must be an integer literal (even on float fields)", p)
        cstr.add newColonExpr(ident(n), someOf(p[1]))
      elif n == "enumOf":
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr} or p[1].kind != nnkBracket or p[1].len == 0:
          error("field '" & name & "': enumOf needs a non-empty [\"a\", \"b\"] literal", p)
        for e in p[1]: discard strLit(e, "field '" & name & "': enumOf value")
        kind = "ftEnum"
        enumVals = nnkPrefix.newTree(ident"@", p[1].copyNimTree)
      else:
        error("unknown field pragma '" & n & "' on field '" & name & "'", p)
  cstr.add newColonExpr(ident"type", ident(kind))
  if enumVals != nil: cstr.add newColonExpr(ident"enum", enumVals)
  result = nnkObjConstr.newTree(ident"FieldSpec")
  for c in cstr: result.add c

proc splitIdentDefs(def: NimNode): tuple[name, pragmas: NimNode] =
  ## `name {.p.}: T` / `name* {.p.}: T` / `name: T` / `name*: T`
  var n = def[0]
  var pragmas = newEmptyNode()
  if n.kind == nnkPragmaExpr:
    pragmas = n[1]; n = n[0]
  if n.kind == nnkPostfix: n = n[1]
  (n, pragmas)

proc fieldsOfObject(td: NimNode, nested: Table[string, NimNode]): NimNode =
  ## `@[FieldSpec(...), ...]` for one object type def; also strips our pragmas from `td` in place.
  let obj = td[2]
  if obj.kind != nnkObjectTy: error("restful: only `object` types are supported", td)
  var arr = nnkBracket.newTree()
  let recList = obj[2]
  for i in 0 ..< recList.len:
    let def = recList[i]
    if def.kind != nnkIdentDefs: error("restful: unsupported field declaration", def)
    if def.len != 3: error("restful: declare one field per line", def)
    let (nameNode, pragmas) = splitIdentDefs(def)
    arr.add fieldCstr(nameNode, def[1], pragmas, nested)
    # strip pragmas so the emitted Nim type is plain
    if def[0].kind == nnkPragmaExpr: recList[i][0] = def[0][0]
  nnkPrefix.newTree(ident"@", arr)

proc parseAction(stmt: NimNode, nested: Table[string, NimNode]): NimNode =
  ## `action "name"[, description = "..."][, transactional = false]:` body with `transition`/`input`.
  var cstr: seq[NimNode] = @[]
  var body: NimNode = newEmptyNode()
  for i in 1 ..< stmt.len:
    let a = stmt[i]
    if a.kind == nnkStmtList: body = a
    elif i == 1: cstr.add newColonExpr(ident"name", strLit(a, "action name"))
    elif a.kind == nnkExprEqExpr and a[0].strVal == "description":
      cstr.add newColonExpr(ident"description", someOf(strLit(a[1], "action description")))
    elif a.kind == nnkExprEqExpr and a[0].strVal == "transactional":
      cstr.add newColonExpr(ident"transactional", someOf(a[1]))
    else: error("action: unexpected argument " & a.repr, a)
  if body.kind != nnkEmpty:
    for s in body:
      if s.kind in {nnkCommand, nnkCall} and s[0].strVal == "transition":
        if s.len != 4: error("transition needs (stateField, from, to)", s)
        cstr.add newColonExpr(ident"stateField", someOf(strLit(s[1], "transition stateField")))
        cstr.add newColonExpr(ident"from", someOf(strLit(s[2], "transition from")))
        cstr.add newColonExpr(ident"to", someOf(strLit(s[3], "transition to")))
      elif s.kind == nnkCall and s[0].strVal == "input":
        var arr = nnkBracket.newTree()
        for f in s[1]:
          # `reason {.max: 200, optional.}: string` parses as Call(PragmaExpr|Ident, StmtList(Type))
          if f.kind != nnkCall or f.len != 2: error("input: expected `name {.pragmas.}: Type`", f)
          var n = f[0]; var pragmas = newEmptyNode()
          if n.kind == nnkPragmaExpr: pragmas = n[1]; n = n[0]
          arr.add fieldCstr(n, f[1][0], pragmas, nested)
        cstr.add newColonExpr(ident"input", nnkPrefix.newTree(ident"@", arr))
      else: error("action body: expected `transition` or `input:`", s)
  result = nnkObjConstr.newTree(ident"ActionSpec")
  for c in cstr: result.add c

proc identList(n: NimNode, what: string): NimNode =
  if n.kind != nnkBracket or n.len == 0: error(what & " must be a non-empty [a, b] literal", n)
  var arr = nnkBracket.newTree()
  for e in n:
    if e.kind == nnkIdent: arr.add newLit(e.strVal)
    else: arr.add strLit(e, what)
  nnkPrefix.newTree(ident"@", arr)

macro restful*(path: string, args: varargs[untyped]): untyped =
  ## restful "users", description = "...", tags = ["x"], transports = [rest, rpc], ops = [list, get],
  ##                  pagination = cursor, security = SecuritySpec(...):
  ##   type <nested...>; <Entity> = object ...   # LAST type in the block is the entity
  ##   action "name", description = "...": transition ...; input: ...
  if args.len == 0 or args[^1].kind != nnkStmtList: error("restful: missing block body", path)
  let body = args[^1]
  var e: seq[NimNode] = @[newColonExpr(ident"specVersion", ident"SpecVersion"),
                          newColonExpr(ident"path", strLit(path, "restful path"))]
  var transports = nnkPrefix.newTree(ident"@", nnkBracket.newTree(newLit"rest"))
  var ops = nnkPrefix.newTree(ident"@", nnkBracket.newTree(newLit"list", newLit"get", newLit"create", newLit"update", newLit"delete"))
  var pagination = newLit"offset"
  for i in 0 ..< args.len - 1:
    let a = args[i]
    if a.kind != nnkExprEqExpr: error("restful: expected `name = value`", a)
    case a[0].strVal
    of "description": e.add newColonExpr(ident"description", someOf(strLit(a[1], "description")))
    of "tags": e.add newColonExpr(ident"tags", someOf(identList(a[1], "tags")))
    of "transports": transports = identList(a[1], "transports")
    of "ops": ops = identList(a[1], "ops")
    of "pagination": pagination = (if a[1].kind == nnkIdent: newLit(a[1].strVal) else: strLit(a[1], "pagination"))
    of "security": e.add newColonExpr(ident"security", someOf(a[1]))
    else: error("restful: unknown option '" & a[0].strVal & "'", a)
  e.add newColonExpr(ident"transports", transports)
  e.add newColonExpr(ident"ops", ops)
  e.add newColonExpr(ident"pagination", pagination)

  var typeSection: NimNode = nil
  var nested = initTable[string, NimNode]()
  var entityName = ""
  var fields: NimNode = nil
  var actions = nnkBracket.newTree()
  for stmt in body:
    case stmt.kind
    of nnkTypeSection:
      if typeSection != nil: error("restful: only one `type` section per block", stmt)
      typeSection = stmt
      for td in stmt:
        let nameNode = (if td[0].kind == nnkPragmaExpr: td[0][0] else: td[0])
        let tname = (if nameNode.kind == nnkPostfix: nameNode[1] else: nameNode).strVal
        let fs = fieldsOfObject(td, nested)
        nested[tname] = fs
        entityName = tname; fields = fs
    of nnkCommand, nnkCall:
      if stmt[0].kind == nnkIdent and stmt[0].strVal == "action": actions.add parseAction(stmt, nested)
      else: error("restful: unexpected statement " & stmt.repr, stmt)
    else: error("restful: unexpected statement " & stmt.repr, stmt)
  if typeSection == nil: error("restful: block needs a `type` section with the entity object", body)
  e.add newColonExpr(ident"entity", newLit(entityName))
  e.add newColonExpr(ident"fields", fields)
  if actions.len > 0: e.add newColonExpr(ident"actions", nnkPrefix.newTree(ident"@", actions))
  var cstr = nnkObjConstr.newTree(ident"EntitySpec")
  for c in e: cstr.add c
  let specSym = genSym(nskConst, entityName & "Spec")
  let entityIdent = ident(entityName)
  result = quote do:
    `typeSection`
    const `specSym` = block:
      let s = `cstr`
      validateEntitySpec(s)   # a ValueError here is a compile error carrying the message
      s
    template entitySpec*(_: typedesc[`entityIdent`]): EntitySpec = `specSym`
  when defined(restfulDebug): echo result.repr
```

- [ ] **Step 4: Create the fixture entity and emitter**

`nim/examples/user.nim` (must marshal byte-identical to `contracts/fixtures/entity-spec.valid-user.json`; compare with `go/internal/example/user.go`):
```nim
## Mirrors contracts/fixtures/entity-spec.valid-user.json — the parity input.
import std/times
import server_decorator/entity

restful "users", description = "A registered user account", tags = ["identity"],
        transports = [rest, rpc, sse, ws],
        security = SecuritySpec(
          schemes: @[SecurityScheme(name: "bearerAuth", `type`: "http", scheme: some("bearer"), bearerFormat: some("JWT"))],
          ops: @[("create", @["user:write"]), ("update", @["user:write"]), ("delete", @["user:admin"])],
          actions: @[("activate", @["user:admin"])]):
  type
    Profile* = object
      bio* {.max: 500, optional.}: string
    User* = object
      id* {.role: "id", readonly.}: string
      email* {.description: "Primary contact address", format: "email", filterable.}: string
      name* {.min: 2, max: 80.}: string
      status* {.enumOf: ["inactive", "active", "banned"], filterable.}: string
      loginCount* {.min: 0, readonly.}: int
      tags*: seq[string]
      profile* {.optional.}: Profile
      birthday* {.nullable, optional.}: DateTime
      score* {.min: 0, optional.}: float
      active* {.optional.}: bool
      secretNote* {.max: 100, writeonly, optional.}: string
  action "activate", description = "Move a dormant account back to active":
    transition "status", "inactive", "active"
    input:
      reason {.max: 200, optional.}: string
  action "ping"
```

`nim/examples/emit_fixture.nim`:
```nim
import server_decorator/entity
import ./user
stdout.write canonical(entitySpec(User))
```

- [ ] **Step 5: Run the tests and the byte-parity check**

Run: `nim r --hints:off tests/t_entity.nim && nim r --hints:off tests/t_compile_errors.nim`
Expected: 5 × `[OK]` then 4 × `[OK]`.

Run (from `nim/`): `nim r --hints:off examples/emit_fixture.nim | cmp - ../contracts/fixtures/entity-spec.valid-user.json && echo IR-OK`
Expected: `IR-OK` (cmp silent).

- [ ] **Step 6: Commit**

```bash
git add nim/src/server_decorator/entity.nim nim/examples nim/tests
git commit -m "feat(nim): restful block macro + field pragmas; User fixture byte-identical; compile-error harness"
```

- [ ] **Step 7: Phase gate** (rule 7): `nimble test` green → independent review of the macro (`code-reviewer` + a second pass focused on: every `error()` names the field; pragmas are stripped from the emitted type; `item` name injection at every list level) → `/simplify` → re-run `nimble test` + the `cmp` above.

---

### Task 4: `gen_openapi.nim` port, umbrella module, OpenAPI parity + cases

**Files:**
- Create: `nim/src/server_decorator/gen_openapi.nim`, `nim/src/server_decorator.nim`, `nim/examples/emit_openapi.nim`
- Test: `nim/tests/t_openapi.nim`, `nim/tests/t_cases.nim`

**Interfaces:**
- Consumes: `entitySpec(User)` from `examples/user.nim`; `parseEntitySpec` from Task 1; `canonicalJson`.
- Produces: `openapiDocument*(specs: seq[EntitySpec], version: string): JsonNode`, `openapiCanonical*(specs, version): string`, `openapiComponents*`, `openapiPaths*`, `jsonSchemaForField*`, `objectProperties*`, `capitalize*`, `problemSchemas*()`, `EmailPattern* UuidPattern* UriPattern*`.

- [ ] **Step 1: Write the failing tests**

`nim/tests/t_openapi.nim`:
```nim
import std/[unittest, os, json]
import server_decorator/gen_openapi
import ../examples/user

let root = currentSourcePath().parentDir / "../.."

suite "gen_openapi":
  test "User document == contracts/fixtures/openapi.valid-user.json (byte-identical)":
    check openapiCanonical(@[entitySpec(User)], "1.2.0") == readFile(root / "contracts/fixtures/openapi.valid-user.json")
  test "EmailPattern is the exact string the fixture carries; uuid/uri lengths match the TS literals":
    let fx = parseJson(readFile(root / "contracts/fixtures/openapi.valid-user.json"))
    check EmailPattern == fx["components"]["schemas"]["UserCreate"]["properties"]["email"]["pattern"].getStr
    check UuidPattern.len == 77 and UriPattern.len == 36
```

`nim/tests/t_cases.nim`:
```nim
## Runs the `openapi` cases in contracts/fixtures/entity-spec.cases.json (same runner as
## gen-openapi/src/cases.spec.ts and gen_openapi's test_cases.py): RFC 6901 pointers, absent == null.
import std/[unittest, json, os, strutils]
import server_decorator/entity, server_decorator/entity/parse, server_decorator/gen_openapi

proc resolve(doc: JsonNode, pointer: string): JsonNode =
  var node = doc
  for raw in pointer.split('/')[1..^1]:
    if node.isNil or node.kind == JNull: return newJNull()
    let key = raw.replace("~1", "/").replace("~0", "~")
    case node.kind
    of JArray: node = (if key.parseInt < node.len: node[key.parseInt] else: nil)
    of JObject: node = (if node.hasKey(key): node[key] else: nil)
    else: return newJNull()
  if node.isNil: newJNull() else: node

let cases = parseJson(readFile(currentSourcePath().parentDir / "../../contracts/fixtures/entity-spec.cases.json"))
suite "entity-spec.cases.json — openapi":
  test "runs at least one case": check cases["openapi"].len > 0
  for c in cases["openapi"]:
    test c["name"].getStr:
      let doc = openapiDocument(@[parseEntitySpec(c["spec"])], "1.2.0")
      for pointer, expected in c["expect"].pairs:
        check canonicalJson(resolve(doc, pointer)) == canonicalJson(expected)
```

- [ ] **Step 2: Run to verify they fail** — `nim r --hints:off tests/t_openapi.nim` → `cannot open file: server_decorator/gen_openapi`.

- [ ] **Step 3: Create the port** `nim/src/server_decorator/gen_openapi.nim` (each section is labelled with the TS file it mirrors; keep it that way)

```nim
## Straight port of node/packages/gen-openapi/src (map-field, components, paths, document, patterns).
## Output goes through entity/canonical so the document is byte-identical to the Node/Python twins.
import std/[json, options, algorithm, sequtils, strutils]
import ./entity/types, ./entity/canonical
export canonical

# --- patterns.ts (copied verbatim; the JS `.source` keeps `/` unescaped and `\/` as written) ---
const EmailPattern* = "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
const UuidPattern* = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
const UriPattern* = "^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s]+$"

type Keep* = proc(f: FieldSpec): bool
proc keepAll*(f: FieldSpec): bool = true

# --- map-field.ts ---
proc baseType(t: FieldType): string =
  case t
  of ftStr, ftRef, ftDatetime, ftEnum: "string"
  of ftInt: "integer"
  of ftFloat: "number"
  of ftBool: "boolean"
  of ftList: "array"
  of ftObj: "object"

proc formatPattern(f: string): string =
  case f
  of "email": EmailPattern
  of "uuid": UuidPattern
  of "uri": UriPattern
  else: raise newException(ValueError, "unknown format: " & f)

proc objectProperties*(fields: seq[FieldSpec], keep: Keep): JsonNode
proc jsonSchemaForField*(f: FieldSpec, keep: Keep = keepAll): JsonNode =
  let base = baseType(f.`type`)
  result = newJObject()
  result["type"] = (if f.nullable: %*[base, "null"] else: %base)
  if f.`type` == ftDatetime: result["format"] = %"date-time"
  if f.`type` in {ftStr, ftRef}:
    if f.format.isSome:
      result["format"] = %f.format.get
      result["pattern"] = %formatPattern(f.format.get)
    if f.pattern.isSome: result["pattern"] = %f.pattern.get
    if f.min.isSome: result["minLength"] = %f.min.get
    if f.max.isSome: result["maxLength"] = %f.max.get
  if f.`type` in {ftInt, ftFloat}:
    if f.min.isSome: result["minimum"] = %f.min.get
    if f.max.isSome: result["maximum"] = %f.max.get
  if f.`type` == ftEnum and f.`enum`.len > 0: result["enum"] = %f.`enum`
  if f.`type` == ftList:
    result["items"] = (if f.item.len > 0: jsonSchemaForField(f.item[0], keep) else: newJObject())
    if f.min.isSome: result["minItems"] = %f.min.get
    if f.max.isSome: result["maxItems"] = %f.max.get
  if f.`type` == ftObj:
    let kept = f.fields.filter(keep)
    result["properties"] = objectProperties(kept, keep)
    let required = kept.filterIt(not it.optional).mapIt(it.name)
    if required.len > 0: result["required"] = %required
    result["additionalProperties"] = %false
  if f.description.isSome: result["description"] = %f.description.get

proc objectProperties*(fields: seq[FieldSpec], keep: Keep): JsonNode =
  result = newJObject()
  for f in fields.filter(keep): result[f.name] = jsonSchemaForField(f, keep)

# --- components.ts ---
proc capitalize*(s: string): string =
  if s.len == 0: "" else: s[0].toUpperAscii & s[1..^1]

proc strictObject(fields: seq[FieldSpec], keep: Keep): JsonNode =
  let kept = fields.filter(keep)
  result = %*{"type": "object", "properties": objectProperties(kept, keep)}
  let required = kept.filterIt(not it.optional).mapIt(it.name)
  if required.len > 0: result["required"] = %required
  result["additionalProperties"] = %false

proc listEnvelope(entity, pagination: string): JsonNode =
  let items = %*{"type": "array", "items": {"$ref": "#/components/schemas/" & entity & "Read"}}
  let limit = %*{"type": "integer", "minimum": 1, "maximum": 100}
  if pagination == "cursor":
    return %*{"type": "object",
      "properties": {"items": items, "nextCursor": {"type": ["string", "null"]}},
      "required": ["items", "nextCursor"], "additionalProperties": false}
  %*{"type": "object",
    "properties": {"items": items, "total": {"type": "integer", "minimum": 0}, "limit": limit,
                   "offset": {"type": "integer", "minimum": 0}},
    "required": ["items", "total", "limit", "offset"], "additionalProperties": false}

proc problemSchemas*(): JsonNode = %*{
  "Problem": {"type": "object",
    "properties": {"type": {"type": "string", "format": "uri"}, "title": {"type": "string"},
                   "status": {"type": "integer"}, "detail": {"type": "string"},
                   "instance": {"type": "string", "format": "uri"}},
    "required": ["type", "title", "status"], "additionalProperties": false},
  "ValidationProblem": {"type": "object",
    "properties": {"type": {"type": "string", "format": "uri"}, "title": {"type": "string"},
                   "status": {"type": "integer"}, "detail": {"type": "string"},
                   "instance": {"type": "string", "format": "uri"},
                   "fields": {"type": "array", "items": {"type": "string"}}},
    "required": ["type", "title", "status", "fields"], "additionalProperties": false}}

proc schemeObject(s: SecurityScheme): JsonNode =
  if s.`type` == "apiKey":
    return %*{"type": "apiKey", "in": s.`in`.get(""), "name": s.paramName.get("")}
  result = %*{"type": "http", "scheme": s.scheme.get("")}
  if s.bearerFormat.isSome: result["bearerFormat"] = %s.bearerFormat.get

proc openapiComponents*(spec: EntitySpec): tuple[schemas, securitySchemes: JsonNode] =
  let e = spec.entity
  let create = strictObject(spec.fields, proc(f: FieldSpec): bool = not f.readonly)
  var update = create.copy
  if update.hasKey("required"): update.delete("required")
  var schemas = newJObject()
  schemas[e & "Create"] = create
  schemas[e & "Update"] = update
  schemas[e & "Read"] = strictObject(spec.fields, proc(f: FieldSpec): bool = not f.writeonly)
  schemas[e & "ListResponse"] = listEnvelope(e, spec.pagination)
  for a in spec.actions:
    schemas[e & capitalize(a.name) & "Input"] = strictObject(a.input, keepAll)
  var securitySchemes = newJObject()
  if spec.security.isSome:
    for s in spec.security.get.schemes: securitySchemes[s.name] = schemeObject(s)
  (schemas, securitySchemes)

# --- paths.ts ---
proc problem(status, description: string, component = "Problem"): (string, JsonNode) =
  (status, %*{"description": description,
    "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/" & component}}}})

proc jsonBody(refName: string): JsonNode =
  %*{"content": {"application/json": {"schema": {"$ref": "#/components/schemas/" & refName}}}}

proc idField(spec: EntitySpec): FieldSpec =
  for f in spec.fields:
    if f.role == some("id"): return f
  raise newException(ValueError, spec.entity & ": no field with role \"id\"")

proc securityFor(spec: EntitySpec, key: string, kind: string): Option[JsonNode] =
  if spec.security.isNone: return none(JsonNode)
  let sec = spec.security.get
  let entries = (if kind == "ops": sec.ops else: sec.actions)
  for (k, scopes) in entries:
    if k == key:
      if sec.schemes.len == 0: return none(JsonNode)
      var node = newJObject()
      node[sec.schemes[0].name] = %scopes
      return some(%*[node])
  none(JsonNode)

proc filterParams(spec: EntitySpec): seq[JsonNode] =
  for f in spec.fields:
    if f.filterable:
      var rest = f
      rest.optional = false; rest.nullable = false
      result.add %*{"name": f.name, "in": "query", "required": false, "schema": jsonSchemaForField(rest)}

proc paginationParams(spec: EntitySpec): seq[JsonNode] =
  let limit = %*{"name": "limit", "in": "query", "required": false,
                 "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}
  if spec.pagination == "cursor":
    return @[limit, %*{"name": "cursor", "in": "query", "required": false, "schema": {"type": "string"}}]
  @[limit, %*{"name": "offset", "in": "query", "required": false,
              "schema": {"type": "integer", "minimum": 0, "default": 0}}]

proc op(spec: EntitySpec, operationId: string, extra: JsonNode, responses: seq[(string, JsonNode)],
        security: Option[JsonNode]): JsonNode =
  result = newJObject()
  if spec.tags.isSome: result["tags"] = %spec.tags.get
  result["operationId"] = %operationId
  for k, v in extra.pairs: result[k] = v
  var resp = newJObject()
  for (code, body) in responses: resp[code] = body
  result["responses"] = resp
  if security.isSome: result["security"] = security.get

proc openapiPaths*(spec: EntitySpec): JsonNode =
  let e = spec.entity
  let base = "/" & spec.path
  let id = idField(spec)
  var idNoRole = id
  idNoRole.role = none(string)
  let idParam = %*{"name": id.name, "in": "path", "required": true, "schema": jsonSchemaForField(idNoRole)}
  result = newJObject()
  var collection = newJObject()
  var item = newJObject()
  let ok200 = proc(refName: string): (string, JsonNode) =
    var r = %*{"description": "OK"}
    for k, v in jsonBody(refName).pairs: r[k] = v
    ("200", r)
  if "list" in spec.ops:
    var params = paginationParams(spec) & filterParams(spec)
    params.sort(proc(a, b: JsonNode): int = cmp(a["name"].getStr, b["name"].getStr))
    var responses = @[ok200(e & "ListResponse")]
    if filterParams(spec).len > 0: responses.add problem("400", "Bad Request", "ValidationProblem")
    collection["get"] = op(spec, "list" & e, %*{"parameters": params}, responses, securityFor(spec, "list", "ops"))
  if "create" in spec.ops:
    var body = %*{"required": true}
    for k, v in jsonBody(e & "Create").pairs: body[k] = v
    var created = %*{"description": "Created"}
    for k, v in jsonBody(e & "Read").pairs: created[k] = v
    collection["post"] = op(spec, "create" & e, %*{"requestBody": body},
      @[("201", created), problem("400", "Bad Request", "ValidationProblem")], securityFor(spec, "create", "ops"))
  if "get" in spec.ops:
    item["get"] = op(spec, "get" & e, %*{"parameters": [idParam]},
      @[ok200(e & "Read"), problem("404", "Not Found")], securityFor(spec, "get", "ops"))
  if "update" in spec.ops:
    var body = %*{"required": true}
    for k, v in jsonBody(e & "Update").pairs: body[k] = v
    item["patch"] = op(spec, "update" & e, %*{"parameters": [idParam], "requestBody": body},
      @[ok200(e & "Read"), problem("400", "Bad Request", "ValidationProblem"), problem("404", "Not Found")],
      securityFor(spec, "update", "ops"))
  if "delete" in spec.ops:
    item["delete"] = op(spec, "delete" & e, %*{"parameters": [idParam]},
      @[("204", %*{"description": "No Content"}), problem("404", "Not Found")], securityFor(spec, "delete", "ops"))
  if collection.len > 0: result[base] = collection
  if item.len > 0: result[base & "/{" & id.name & "}"] = item
  for a in spec.actions:
    var extra = %*{"parameters": [idParam]}
    if a.description.isSome: extra["description"] = %a.description.get
    var body = %*{"required": true}
    for k, v in jsonBody(e & capitalize(a.name) & "Input").pairs: body[k] = v
    extra["requestBody"] = body
    var responses = @[ok200(e & "Read"), problem("400", "Bad Request", "ValidationProblem"), problem("404", "Not Found")]
    if a.`from`.isSome: responses.add problem("409", "Conflict")
    var post = newJObject()
    post["post"] = op(spec, a.name & e, extra, responses, securityFor(spec, a.name, "actions"))
    result[base & "/{" & id.name & "}/actions/" & a.name] = post

# --- document.ts ---
proc openapiDocument*(specs: seq[EntitySpec], version: string): JsonNode =
  var schemas = problemSchemas()
  var securitySchemes = newJObject()
  var paths = newJObject()
  var tagNames: seq[string]
  for spec in specs:
    let c = openapiComponents(spec)
    for k, v in c.schemas.pairs: schemas[k] = v
    for k, v in c.securitySchemes.pairs: securitySchemes[k] = v
    for k, v in openapiPaths(spec).pairs: paths[k] = v
    if spec.tags.isSome:
      for t in spec.tags.get:
        if t notin tagNames: tagNames.add t
  result = %*{"openapi": "3.1.0", "info": {"title": "server-decorator API", "version": version},
              "paths": paths, "components": {"schemas": schemas}}
  if tagNames.len > 0:
    tagNames.sort()
    result["tags"] = %tagNames.mapIt(%*{"name": it})
  if securitySchemes.len > 0: result["components"]["securitySchemes"] = securitySchemes

proc openapiCanonical*(specs: seq[EntitySpec], version: string): string =
  canonicalJson(openapiDocument(specs, version))
```

- [ ] **Step 4: Create the umbrella module and the emitter**

`nim/src/server_decorator.nim`:
```nim
## server_decorator — Nim lane. `import server_decorator` re-exports the entity IR layer and the
## OpenAPI generator; `import server_decorator/entity` alone pulls only the IR layer.
import ./server_decorator/entity, ./server_decorator/gen_openapi
export entity, gen_openapi
```

`nim/examples/emit_openapi.nim`:
```nim
import std/[os, strutils]
import server_decorator/gen_openapi
import ./user
let version = readFile(currentSourcePath().parentDir / "../../contracts/VERSION").strip
stdout.write openapiCanonical(@[entitySpec(User)], version)
```

- [ ] **Step 5: Run**

Run: `nim r --hints:off tests/t_openapi.nim && nim r --hints:off tests/t_cases.nim`
Expected: 2 × `[OK]`, then 9 × `[OK]` (the 8 named cases + "runs at least one case").

Run (from `nim/`): `nim r --hints:off examples/emit_openapi.nim | cmp - ../contracts/fixtures/openapi.valid-user.json && echo OA-OK`
Expected: `OA-OK`.

Run: `nimble test` → `Success: All tests passed` (6 modules). Also `nim check --hints:off src/server_decorator.nim` → no `Warning`/`Error` lines.

- [ ] **Step 6: Commit**

```bash
git add nim/src nim/examples/emit_openapi.nim nim/tests
git commit -m "feat(nim): gen_openapi port — byte-identical OpenAPI 3.1 + entity-spec.cases.json openapi suite"
```

- [ ] **Step 7: Phase gate** (rule 7): review the port side-by-side with `node/packages/gen-openapi/src/*.ts` (`code-reviewer`, `model: sonnet`; the fixture + cases already prove behaviour, so the review targets readability and dead branches) → `/simplify` → re-run `nimble test` and both `cmp` checks.

---

### Task 5: Wiring — parity scripts, version lockstep, CI, gitignore

**Files:**
- Modify: `scripts/check-entity-parity.sh`, `scripts/check-openapi-parity.sh`, `scripts/check-versions.sh:23-26`, `scripts/bump-version.sh:35-39`, `.github/workflows/ci-contracts.yml:13-31,64-79`, `.github/workflows/ci-node.yml:106`, `.gitignore`
- Create: `.github/workflows/ci-nim.yml`

**Interfaces:**
- Consumes: `nim/examples/emit_fixture.nim`, `nim/examples/emit_openapi.nim` (stdout = canonical string, no trailing newline), `nim/server_decorator.nimble` `version` line.

All edits are made from the repo root of the F-006 worktree.

- [ ] **Step 1: `scripts/check-entity-parity.sh`** — replace the whole file with:

```bash
#!/usr/bin/env bash
# Assert TS, Python, Go and Nim entity declarations emit byte-identical IR, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/entity-spec.valid-user.json
ts_out=$(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts)
py_out=$(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
go_out=$(go run ./go/internal/example/emitfixture)
command -v nim >/dev/null || { echo "nim not on PATH (export PATH=\$HOME/.nimble/bin:\$PATH)" >&2; exit 1; }
# nim/examples/config.nims adds ../src to the path; --hints:off keeps stdout to the program's output.
nim_out=$(nim r --hints:off nim/examples/emit_fixture.nim)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS IR != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY IR != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$go_out" = "$expected" ] || { echo "FAIL: GO IR != $fixture" >&2; diff <(echo "$go_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$nim_out" = "$expected" ] || { echo "FAIL: NIM IR != $fixture" >&2; diff <(echo "$nim_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: entity-spec parity (TS == PY == GO == NIM == contract fixture)"
```

- [ ] **Step 2: `scripts/check-openapi-parity.sh`** — replace the whole file with:

```bash
#!/usr/bin/env bash
# Assert TS, Python and Nim emit a byte-identical OpenAPI document, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/openapi.valid-user.json

# The emitter resolves @montionugera/entity-spec through dist/, which does not exist on a
# clean checkout — build it first, the same reason gen-*/package.json carries pretest:unit.
# (check-entity-parity.sh needs no equivalent: its emitter imports ../src directly.)
( cd node && pnpm --filter @montionugera/entity-spec run build >/dev/null )

ts_out=$(cd node/packages/gen-openapi && pnpm exec tsx scripts/emit-openapi.ts)
py_out=$(cd python && uv run --package server-decorator-gen-openapi \
  python packages/gen_openapi/scripts/emit_openapi.py)
command -v nim >/dev/null || { echo "nim not on PATH (export PATH=\$HOME/.nimble/bin:\$PATH)" >&2; exit 1; }
nim_out=$(nim r --hints:off nim/examples/emit_openapi.nim)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS OpenAPI != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY OpenAPI != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$nim_out" = "$expected" ] || { echo "FAIL: NIM OpenAPI != $fixture" >&2; diff <(echo "$nim_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: openapi parity (TS == PY == NIM == contract fixture)"
```

- [ ] **Step 3: `scripts/check-versions.sh`** — insert after the `versions+="go/entity/version.go=$go_v\n"` line (line 26; the Go block is lines 23–26):

```bash

# nim/server_decorator.nimble is the Nim package's only version source (F-006); nimble reads it.
nim_v=$(grep -oE '^version[[:space:]]*=[[:space:]]*"[^"]+"' nim/server_decorator.nimble | grep -oE '"[^"]+"' | tr -d '"') \
  || { echo "FAIL: no 'version = \"x.y.z\"' in nim/server_decorator.nimble" >&2; exit 1; }
versions+="nim/server_decorator.nimble=$nim_v\n"
```
Also change the header comment `(Node + Python + Go)` to `(Node + Python + Go + Nim)`.

- [ ] **Step 4: `scripts/bump-version.sh`** — insert after the `go_version_file` block (after line 39 — the `&& rm "$go_version_file.bak"` line; line 38 ends with a `\` continuation, so inserting after 38 would split the sed command — and before the `uv.lock` comment):

```bash
# Mirror into the Nim package manifest (F-006) — nimble reads `version` from it and
# check-versions.sh asserts it. The capture group keeps the manifest's own spacing.
nimble_file=nim/server_decorator.nimble
sed -i.bak -E "s/^(version[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"$new_version\"/" "$nimble_file" \
  && rm "$nimble_file.bak"
```

- [ ] **Step 5: Verify the scripts locally** (from repo root; needs pnpm deps + uv + go + nim on PATH)

```bash
bash scripts/check-entity-parity.sh && bash scripts/check-openapi-parity.sh && bash scripts/check-versions.sh
```
Expected: `OK: entity-spec parity (TS == PY == GO == NIM == contract fixture)`, `OK: openapi parity (TS == PY == NIM == contract fixture)`, `OK: all packages at 2.0.4` (or the current lockstep version).

Negative check for AC4 (edit the manifest alone, expect failure, then restore):
```bash
sed -i.bak -E 's/^(version[[:space:]]*=[[:space:]]*)"[^"]+"/\1"9.9.9"/' nim/server_decorator.nimble
bash scripts/check-versions.sh; echo "exit=$? (expect 1)"; mv nim/server_decorator.nimble.bak nim/server_decorator.nimble
```
Dry-run the bump in a scratch copy (must rewrite all four lanes, then pass check-versions):
```bash
tmp=$(mktemp -d) && git archive HEAD | tar -x -C "$tmp" && cp -R node/node_modules "$tmp/node/" 2>/dev/null; \
( cd "$tmp" && bash scripts/bump-version.sh patch | tail -3 && grep -n '^version' nim/server_decorator.nimble ); rm -rf "$tmp"
```
Expected: `OK: all packages at 2.0.5` (n+1) and the nimble line shows the same version. (If `pnpm version` needs `node_modules` and the copy failed, run `cd "$tmp/node" && pnpm install --offline` first.)

- [ ] **Step 6: `.github/workflows/ci-contracts.yml`** — add `- 'nim/**'` after `- 'go.sum'` in BOTH path lists (pull_request and push), and in the `entity-parity` job add, directly after the `actions/setup-go@v5` step:

```yaml
      # check-entity-parity.sh and check-openapi-parity.sh run the Nim producers too (F-006).
      - uses: jiro4989/setup-nim-action@v2
        with:
          nim-version: '2.2.12'
          repo-token: ${{ secrets.GITHUB_TOKEN }}  # avoids GitHub API rate-limit flakes when resolving the toolchain
```

- [ ] **Step 7: Create `.github/workflows/ci-nim.yml`** (mirrors `ci-go.yml`: check + tests only; parity stays in `ci-contracts.yml`)

```yaml
name: CI - Nim

on:
  pull_request:
    paths: ['nim/**', 'contracts/**', '.github/workflows/ci-nim.yml']
  push:
    branches: [main]
    paths: ['nim/**', 'contracts/**', '.github/workflows/ci-nim.yml']

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run: { working-directory: nim }
    steps:
      - uses: actions/checkout@v4
      # Pinned to the version in nim/README.md / CLAUDE.md; the package has no third-party deps,
      # so there is no lockfile and nothing to cache.
      - uses: jiro4989/setup-nim-action@v2
        with:
          nim-version: '2.2.12'
          repo-token: ${{ secrets.GITHUB_TOKEN }}  # avoids GitHub API rate-limit flakes when resolving the toolchain
      - run: nimble check
      - name: nim check (no warnings)
        run: |
          out=$(nim check --hints:off src/server_decorator.nim 2>&1) || { echo "$out"; exit 1; }
          echo "$out" | grep -q 'Warning' && { echo "$out"; exit 1; } || true
      # Byte parity with both fixtures, the cases.json openapi suite, validate.ts port, compile-error harness.
      - run: nimble -y test
```

- [ ] **Step 8: `.github/workflows/ci-node.yml` line 106** — append ` nim/server_decorator.nimble` to the `git add` list so the post-merge auto-bump commits the Nim manifest (otherwise `check-versions.sh` goes red on `main` right after the first publish):

```
          git add node/packages/*/package.json node/pnpm-lock.yaml python/packages/*/pyproject.toml python/packages/*/src/*/_version.py python/uv.lock go/entity/version.go nim/server_decorator.nimble
```

- [ ] **Step 9: `.gitignore`** — append:

```
# Nim (F-006): `nim c` drops binaries beside sources; `nim r`/`nimble test` do not, but be safe.
nimcache/
nim/tests/t_*
!nim/tests/t_*.nim
nim/examples/emit_*
!nim/examples/emit_*.nim
nim/examples/user
```

- [ ] **Step 10: Verify YAML + commit**

```bash
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci-nim.yml','.github/workflows/ci-contracts.yml']]; print('yaml ok')" 2>/dev/null || ruby -ryaml -e "YAML.load_file('.github/workflows/ci-nim.yml'); YAML.load_file('.github/workflows/ci-contracts.yml'); puts 'yaml ok'"
git status --short   # must show nothing under nim/ that is a build artefact
git add scripts .github .gitignore
git commit -m "ci(nim): wire Nim into parity scripts, version lockstep, ci-contracts, new ci-nim; publish allowlist"
```

- [ ] **Step 11: Phase gate** — shared with Task 6.

---

### Task 6: Docs — `nim/README.md`, `CLAUDE.md`; final verification; handoff

**Files:**
- Create: `nim/README.md`
- Modify: `CLAUDE.md:9` (lanes paragraph), `CLAUDE.md:44-54` (commands table), the "Things that will trip you up" list.

- [ ] **Step 1: Create `nim/README.md`**

````markdown
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
````

- [ ] **Step 2: Edit `CLAUDE.md`**

After the paragraph at line 9 ("A third lane, **Go** …") add:
```
A fourth lane, **Nim** (`nim/`, nimble package `server_decorator`, Nim 2.2.12), ships the `entity` IR producer (a `restful` block macro + field pragmas — the decorator ergonomics Go could not offer) **and** the OpenAPI generator (`server_decorator/gen_openapi`), both byte-identical to the Node/Python twins; see `nim/README.md`.
```
In the commands table, after the `Regenerate Go example IR` row add:
```
| Nim tests (byte parity, cases.json openapi suite, compile-error harness) | `export PATH=$HOME/.nimble/bin:$PATH && cd nim && nimble test` (Nim 2.2.12, stdlib only) |
| Nim hygiene | `cd nim && nimble check && nim check --hints:off src/server_decorator.nim` |
```
Update the two parity rows: `Entity-spec parity` → "asserts Node, Python, Go and Nim `entity` packages …"; `OpenAPI parity` → "asserts Node, Python and Nim emit byte-identical OpenAPI …".
In "Things that will trip you up" add one bullet:
```
- **Nim is pinned to 2.2.12** (`ci-nim.yml`, `ci-contracts.yml`, `nim/README.md`); on the maintainer Mac it lives at `~/.nimble/bin` (not on PATH — `export PATH=$HOME/.nimble/bin:$PATH` first; do not use brew/choosenim). The package has zero dependencies: never commit `nimble.lock`. Nested `obj` types must be declared inside the same `restful` block, and `min`/`max` are integer literals even on `float` fields.
```
Also in the "Common commands" intro sentence mention `nim/` alongside `node/`/`python/` if it lists workspace roots (keep it to one clause).

- [ ] **Step 3: Full verification (AC1–AC6)** from the repo root:

```bash
export PATH=$HOME/.nimble/bin:$PATH
( cd nim && nimble check && nimble test 2>&1 | tail -1 )                     # AC3
bash scripts/check-entity-parity.sh                                            # AC1
bash scripts/check-openapi-parity.sh                                           # AC2
bash scripts/check-versions.sh                                                 # AC4
( cd node && corepack pnpm -r run build >/dev/null && corepack pnpm -r test:unit 2>&1 | grep -E 'Tests:|failed' )
( cd python && bash scripts/check.sh 2>&1 | tail -3 )
go test ./go/... 2>&1 | tail -3
grep -n '2.2.12' nim/README.md .github/workflows/ci-nim.yml .github/workflows/ci-contracts.yml CLAUDE.md | wc -l   # AC6: ≥ 4
```
All must exit 0. AC5 (CI green) is observed on the release PR after `psrw ship`.

- [ ] **Step 4: Commit**

```bash
git add nim/README.md CLAUDE.md
git commit -m "docs(nim): README + CLAUDE.md for the Nim lane (F-006)"
```

- [ ] **Step 5: Phase gate (Tasks 5+6)** (rule 7): re-run Step 3 → independent review of `git diff release/1.2 -- scripts .github .gitignore CLAUDE.md nim/README.md` (`code-reviewer`, `model: sonnet`; focus: every CI job that now invokes `nim` has setup-nim; publish allowlist; README example compiles — paste it into a scratch file and `nim check` it) → fix → re-run Step 3.

- [ ] **Step 6: Ship** — `git status` clean, then from inside the F-006 worktree run `psrw ship --no-deploy` (Gate 1 skips silently: `scripts/precheck.sh` does not exist — Step 3 above IS the gate). If the tool is permission-denied in auto mode, stop and ask the user to run it. Do **not** promote.

---

## Self-review (writing-plans, 2026-09-13)

- Spec coverage: Goals 1–3 → Tasks 3, 4, 5. AC1/AC2 → Task 5 Step 5; AC3 → Tasks 1–4 + `t_compile_errors`; AC4 → Task 5 Steps 3–5; AC5 → Task 5 Steps 6–8; AC6 → Task 6. Non-goals respected (no `contracts/` change; Nim follows Node on `tags:[]`). Spec H3 (nested types in the same block) → `outside_nested_type.nim`; M5 (`Option[int]` on floats) → `types.nim` + `t_entity` "explicit min: 0"; M6 (ci-nim = check/test only) → Task 5 Step 7.
- Placeholders: none — every code block is the file that ran in the scratchpad.
- Type consistency: `Keep`, `keepAll`, `ScopeEntry`, `SpecVersion`, `entitySpec(User)`, `canonical`, `openapiCanonical` are spelled identically across tasks and tests.

## Appendix — audit trail
- 2026-09-13 self-grill-audit (independent agent; re-materialised all plan Nim files in /tmp/f006-audit: nimble check valid, 32/32 tests OK, both fixtures byte-identical, no lockfile): verdict **safe-with-fixes**. Corrected: HIGH-1 `canonical.nim` now hand-rolls `escapeString` (lowercase `\u00xx`; `std/json.escapeJson` emits uppercase and breaks parity for 0x0E–0x1F) + new `t_canonical` case — escaper re-verified byte-identical to `JSON.stringify` for all 32 control chars; MED-2 `bump-version.sh` insert moved to after line 39 (line 38 is a `\` continuation), `check-versions.sh` block cited as 23–26 / insert after 26; MED-3 `command -v nim` guard added to both parity scripts; MED-4 `repo-token` added to both `setup-nim-action` steps; LOW-5 `nim/examples/user` binary gitignored; LOW-6 README install URL marked untested with fallback. Left: LOW-7 `ci-contracts.yml:62` step name still says "(Node <-> Python)" (cosmetic).
  Open: none.

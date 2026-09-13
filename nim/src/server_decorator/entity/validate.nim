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

## Coverage for the `restful` macro (entity.nim) beyond the User fixture and Minimal:
## every option, pragma, type mapping and action form on the happy path, plus every `error(...)`
## branch as a compile-time rejection (same `nim check` harness as t_compile_errors.nim, with the
## snippets inlined so no shared file is touched).
import std/[unittest, json, os, osproc, strutils, times]
import server_decorator/entity

# --- happy paths -------------------------------------------------------------------------------

restful "orders", description = """Customer orders""", tags = ["sales", billing],
        transports = ["rest", ws], ops = [list, get], pagination = cursor:
  type
    Line = object
      sku {.pattern: r"^[A-Z]{3}-[0-9]+$".}: string
      qty {.min: 1, max: 99.}: int32
    Order* {.inheritable.} = object
      id* {.role: "id", readonly.}: string
      customer {.refTo: "User", description: "owner".}: string
      lines: seq[Line]
      total: float64
      big: int64
      paid: bool
      placedAt: Time
      state {.enumOf: ["open", "closed"].}: string
  action("cancel", transactional = false)
  action "annotate", description = "Add a note":
    input:
      text {.nullable, optional, max: 10.}: string
      labels: seq[string]
  action "reopen", transactional = true:
    transition("state", "closed", "open")

restful "pings", pagination = "cursor", ops = ["get"]:
  type Ping = object

restful "temps":
  type Temp = object
    celsius {.min: -273, max: -0.}: int

suite "restful macro — options":
  let j = toJson(entitySpec(Order))

  test "path, entity name (last type in the block) and specVersion":
    check j["path"].getStr == "orders"
    check j["entity"].getStr == "Order"
    check j["specVersion"].getStr == SpecVersion

  test "triple-quoted description is accepted as a string literal":
    check j["description"].getStr == "Customer orders"

  test "tags / transports accept a mix of string literals and bare identifiers, in order":
    check j["tags"] == %*["sales", "billing"]
    check j["transports"] == %*["rest", "ws"]

  test "a custom ops list replaces the five defaults":
    check j["ops"] == %*["list", "get"]

  test "pagination accepts a bare identifier and a string literal":
    check j["pagination"].getStr == "cursor"
    check entitySpec(Ping).pagination == "cursor"

  test "string-literal ops and an entity with no fields":
    check entitySpec(Ping).ops == @["get"]
    check entitySpec(Ping).fields.len == 0
    check entitySpec(Ping).actions.len == 0
    check toJson(entitySpec(Ping))["fields"] == %*[]

suite "restful macro — fields":
  let fields = toJson(entitySpec(Order))["fields"]

  test "declaration order is preserved and only the entity's own fields are listed":
    var names: seq[string]
    for f in fields: names.add f["name"].getStr
    check names == @["id", "customer", "lines", "total", "big", "paid", "placedAt", "state"]

  test "refTo turns the field into a ref carrying the target, alongside other string pragmas":
    check fields[1] == %*{"name": "customer", "type": "ref", "description": "owner", "ref": "User"}

  test "seq of a nested object: item is an obj with the nested type's fields and the list's name":
    check fields[2]["type"].getStr == "list"
    check fields[2]["item"]["name"].getStr == "lines"
    check fields[2]["item"]["type"].getStr == "obj"
    check fields[2]["item"]["fields"] == %*[
      {"name": "sku", "type": "str", "pattern": "^[A-Z]{3}-[0-9]+$"},
      {"name": "qty", "type": "int", "min": 1, "max": 99}]

  test "numeric, bool and time type aliases map to the IR types":
    check fields[3] == %*{"name": "total", "type": "float"}
    check fields[4] == %*{"name": "big", "type": "int"}
    check fields[5] == %*{"name": "paid", "type": "bool"}
    check fields[6] == %*{"name": "placedAt", "type": "datetime"}

  test "enumOf switches the type to enum and keeps the values in order":
    check fields[7] == %*{"name": "state", "type": "enum", "enum": ["open", "closed"]}

  test "a tight negative literal (`-273`) is an int literal and is accepted; -0 is 0":
    # NOTE: the macro's error text says "negative literals are not supported", but only the spaced
    # prefix form (`- 1`, see min_prefix_minus below) is rejected. Accepting `-273` matches the
    # Node/Python twins, which allow any integer bound.
    check toJson(entitySpec(Temp))["fields"] == %*[{"name": "celsius", "type": "int", "min": -273, "max": 0}]

  test "the emitted Nim types are plain objects with the field pragmas stripped":
    let o = Order(id: "1", customer: "u1", lines: @[Line(sku: "ABC-1", qty: 2)], total: 9.5, big: 1,
                  paid: true, state: "open")
    check o.lines[0].qty == 2'i32
    check o.customer == "u1"
    check Ping() == Ping()

suite "restful macro — actions":
  let spec = entitySpec(Order)
  let acts = toJson(spec)["actions"]

  test "call-form action with transactional = false and no body":
    check acts[0] == %*{"name": "cancel", "transactional": false}
    check spec.actions[0].transactional == some(false)
    check spec.actions[0].input.len == 0

  test "input-only action: nullable/optional flags, a bound, and a pragma-less list field":
    check acts[1] == %*{"name": "annotate", "description": "Add a note", "input": [
      {"name": "text", "type": "str", "max": 10, "optional": true, "nullable": true},
      {"name": "labels", "type": "list", "item": {"name": "labels", "type": "str"}}]}
    check spec.actions[1].stateField.isNone

  test "transactional = true is recorded but not emitted; call-form transition is accepted":
    check spec.actions[2].transactional == some(true)
    check acts[2] == %*{"name": "reopen", "stateField": "state", "from": "closed", "to": "open"}

# --- compile-time rejections -------------------------------------------------------------------

const Rejections = [
  ("pragma_dot_expr", """
restful "t":
  type T = object
    id {.a.b.}: string
""", "unsupported pragma syntax"),
  ("string_pragma_non_string", """
restful "t":
  type T = object
    id {.description: 5.}: string
""", "field 'id': description must be a string literal"),
  ("string_pragma_bare", """
restful "t":
  type T = object
    id {.description.}: string
""", "field 'id': 'description' needs a string value"),
  ("flag_with_value", """
restful "t":
  type T = object
    id {.readonly: true.}: string
""", "field 'id': flag 'readonly' takes no value"),
  ("generic_non_seq_type", """
restful "t":
  type T = object
    id: Option[int]
""", "field 'id': unsupported type Option[int]"),
  ("ref_type", """
restful "t":
  type T = object
    id: ref int
""", "field 'id': unsupported type"),
  ("seq_of_unknown_type", """
restful "t":
  type T = object
    xs: seq[Missing]
""", "field 'xs': unknown type 'Missing'"),
  ("min_prefix_minus", """
restful "t":
  type T = object
    n {.min: - 1.}: int
""", "field 'n': 'min' must be a non-negative integer literal (negative literals are not supported)"),
  ("max_string", """
restful "t":
  type T = object
    n {.max: "9".}: int
""", "field 'n': 'max' must be a non-negative integer literal"),
  ("min_float_literal", """
restful "t":
  type T = object
    n {.min: 1.5.}: float
""", "field 'n': 'min' must be a non-negative integer literal"),
  ("min_bare", """
restful "t":
  type T = object
    n {.min.}: int
""", "field 'n': 'min' must be a non-negative integer literal"),
  ("enum_empty", """
restful "t":
  type T = object
    s {.enumOf: [].}: string
""", "field 's': enumOf needs a non-empty"),
  ("enum_not_a_list", """
restful "t":
  type T = object
    s {.enumOf: "a".}: string
""", "field 's': enumOf needs a non-empty"),
  ("enum_non_string_value", """
restful "t":
  type T = object
    s {.enumOf: [1, 2].}: string
""", "field 's': enumOf value must be a string literal"),
  ("ref_object", """
restful "t":
  type T = ref object
    id: string
""", "restful: only `object` types are supported"),
  ("type_alias", """
restful "t":
  type T = int
""", "restful: only `object` types are supported"),
  ("variant_object", """
restful "t":
  type T = object
    case kind: bool
    of true: a: string
    of false: b: string
""", "restful: unsupported field declaration"),
  ("two_fields_per_line", """
restful "t":
  type T = object
    a, b: string
""", "restful: declare one field per line"),
  ("action_unknown_argument", """
restful "t":
  type T = object
    id: string
  action "x", foo = "y"
""", "action: unexpected argument"),
  ("action_positional_extra", """
restful "t":
  type T = object
    id: string
  action "x", "y"
""", "action: unexpected argument"),
  ("action_name_not_string", """
restful "t":
  type T = object
    id: string
  action foo
""", "action name must be a string literal"),
  ("action_description_not_string", """
restful "t":
  type T = object
    id: string
  action "x", description = 5
""", "action description must be a string literal"),
  ("transition_arity", """
restful "t":
  type T = object
    id: string
  action "x":
    transition "status", "a"
""", "transition needs (stateField, from, to)"),
  ("transition_non_string", """
restful "t":
  type T = object
    id: string
  action "x":
    transition status, "a", "b"
""", "transition stateField must be a string literal"),
  ("action_body_unknown", """
restful "t":
  type T = object
    id: string
  action "x":
    foo "y"
""", "action body: expected `transition` or `input:`"),
  ("input_not_a_field", """
restful "t":
  type T = object
    id: string
  action "x":
    input:
      discard
""", "input: expected `name {.pragmas.}: Type`"),
  ("input_unknown_pragma", """
restful "t":
  type T = object
    id: string
  action "x":
    input:
      reason {.bogus.}: string
""", "unknown field pragma 'bogus' on field 'reason'"),
  ("tags_empty", """
restful "t", tags = []:
  type T = object
    id: string
""", "tags must be a non-empty [a, b] literal"),
  ("transports_not_a_list", """
restful "t", transports = rest:
  type T = object
    id: string
""", "transports must be a non-empty [a, b] literal"),
  ("ops_non_identifier", """
restful "t", ops = [1]:
  type T = object
    id: string
""", "ops must be a string literal"),
  ("missing_body_no_args", """
restful "t"
""", "restful: missing block body"),
  ("missing_body_with_option", """
restful("t", description = "d")
""", "restful: missing block body"),
  ("option_not_name_value", """
restful "t", foo:
  type T = object
    id: string
""", "restful: expected `name = value`"),
  ("unknown_option", """
restful "t", bogus = 1:
  type T = object
    id: string
""", "restful: unknown option 'bogus'"),
  ("description_not_string", """
restful "t", description = 5:
  type T = object
    id: string
""", "description must be a string literal"),
  ("pagination_number", """
restful "t", pagination = 5:
  type T = object
    id: string
""", "pagination must be a string literal"),
  ("two_type_sections", """
restful "t":
  type A = object
    id: string
  type B = object
    id: string
""", "restful: only one `type` section per block"),
  ("stray_statement", """
restful "t":
  type T = object
    id: string
  discard
""", "restful: unexpected statement"),
  ("stray_command", """
restful "t":
  type T = object
    id: string
  foo "x"
""", "restful: unexpected statement foo \"x\""),
  ("no_type_section", """
restful "t":
  action "ping"
""", "restful: block needs a `type` section with the entity object"),
  ("validation_security_op_not_declared", """
restful "t", ops = [list],
        security = SecuritySpec(
          schemes: @[SecurityScheme(name: "b", `type`: "http", scheme: some("bearer"))],
          ops: @[("create", @["t:write"])]):
  type T = object
    id: string
""", "T: security.ops.create is not declared in ops"),
  ("validation_action_input_reserved_name", """
restful "t":
  type T = object
    id: string
  action "x":
    input:
      json: string
""", "field \"x.json\": wire name \"json\" is reserved"),
  ("validation_lookaround_pattern", """
restful "t":
  type T = object
    code {.pattern: "(?=a)b".}: string
""", "is not RE2/rust-regex compatible (contains lookaround"),
]

suite "restful macro — compile-time rejections":
  let src = currentSourcePath().parentDir / "../src"
  # per-run directory, removed at the end of the suite: a stale .out from an earlier or concurrent
  # run must never satisfy a readFile below
  let work = getTempDir() / ("sd_entity_cov_" & $getCurrentProcessId())
  removeDir(work)
  createDir(work)

  # one `nim check` per snippet, run concurrently: each is an independent compiler process
  var cmds: seq[string]
  for (name, body, _) in Rejections:
    writeFile(work / name & ".nim", "import server_decorator/entity\n" & body)
    cmds.add "nim check --hints:off --nimcache:" & quoteShell(work / "cache_" & name) &
             " --path:" & quoteShell(src) & " " & quoteShell(work / name & ".nim") &
             " > " & quoteShell(work / name & ".out") & " 2>&1"
  discard execProcesses(cmds, options = {poEvalCommand})

  for (name, _, expected) in Rejections:
    test name:
      let output = readFile(work / name & ".out")
      check "Error:" in output
      check expected in output
      # the macro's own message must be what failed, not an unrelated parse error
      check "invalid indentation" notin output

  test "control: a valid snippet passes the same harness (so a failure above is the snippet's)":
    writeFile(work / "control_ok.nim", "import server_decorator/entity\nrestful \"t\":\n  type T = object\n    id: string\n")
    let (output, code) = execCmdEx("nim check --hints:off --nimcache:" & quoteShell(work / "cache_control_ok") &
                                   " --path:" & quoteShell(src) & " " & quoteShell(work / "control_ok.nim"))
    check code == 0
    check "Error:" notin output

  removeDir(work)

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

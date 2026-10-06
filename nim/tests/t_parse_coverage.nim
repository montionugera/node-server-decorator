## Direct coverage for entity/parse.nim: every FieldType string, the unknown-type error branch,
## optional/flag/zero handling, recursion, and non-User security shapes.
import std/[unittest, json, options]
import server_decorator/entity, server_decorator/entity/parse

suite "parse — parseFieldType":
  test "every wire type string maps to its FieldType":
    check parseFieldType("str") == ftStr
    check parseFieldType("int") == ftInt
    check parseFieldType("float") == ftFloat
    check parseFieldType("bool") == ftBool
    check parseFieldType("datetime") == ftDatetime
    check parseFieldType("enum") == ftEnum
    check parseFieldType("ref") == ftRef
    check parseFieldType("list") == ftList
    check parseFieldType("obj") == ftObj

  test "unknown, empty, Nim-identifier and capitalised strings raise ValueError naming the input":
    for bad in ["string", "", "ftStr", "Str", "object", "str "]:
      var msg = ""
      try:
        discard parseFieldType(bad)
      except ValueError as e:
        msg = e.msg
      check msg == "unknown field type: " & bad

  test "style variants of a wire type (sTR, s_tr, l_ist) are rejected like Node/Python":
    # Regression: std parseEnum is style-insensitive after the first character and would accept
    # these; the JSON Schema enum and the Node/Python twins accept only the exact lowercase strings.
    for bad in ["sTR", "s_tr", "l_ist", "dateTime"]:
      expect ValueError:
        discard parseFieldType(bad)

suite "parse — parseField":
  test "a bare field leaves every optional unset and every flag false":
    let f = parseField(%*{"name": "n", "type": "str"})
    check f.name == "n" and f.`type` == ftStr
    check f.description.isNone and f.role.isNone and f.format.isNone and f.pattern.isNone and f.`ref`.isNone
    check f.min.isNone and f.max.isNone
    check not (f.optional or f.nullable or f.readonly or f.writeonly or f.filterable)
    check f.`enum`.len == 0 and f.item.len == 0 and f.fields.len == 0

  test "every optional string and both bounds are carried through":
    let f = parseField(%*{"name": "owner", "type": "ref", "description": "d", "role": "id", "format": "uuid",
                          "pattern": "^a$", "ref": "User", "min": 3, "max": 9})
    check f.`type` == ftRef
    check f.description == some("d") and f.role == some("id") and f.format == some("uuid")
    check f.pattern == some("^a$") and f.`ref` == some("User")
    check f.min == some(3) and f.max == some(9)

  test "explicit zero and negative bounds survive as some(...)":
    let f = parseField(%*{"name": "n", "type": "int", "min": -5, "max": 0})
    check f.min == some(-5)
    check f.max == some(0)

  test "flags are true only when the key is present AND true":
    let on = parseField(%*{"name": "n", "type": "str", "optional": true, "nullable": true, "readonly": true,
                           "writeonly": true, "filterable": true})
    check on.optional and on.nullable and on.readonly and on.writeonly and on.filterable
    let off = parseField(%*{"name": "n", "type": "str", "optional": false, "nullable": false, "readonly": false,
                            "writeonly": false, "filterable": false})
    check not (off.optional or off.nullable or off.readonly or off.writeonly or off.filterable)

  test "enum values keep their order; an empty enum array stays empty":
    check parseField(%*{"name": "s", "type": "enum", "enum": ["b", "a", "c"]}).`enum` == @["b", "a", "c"]
    check parseField(%*{"name": "s", "type": "enum", "enum": []}).`enum`.len == 0

  test "item recurses through list-of-list":
    let f = parseField(%*{"name": "m", "type": "list",
                          "item": {"name": "m", "type": "list", "item": {"name": "m", "type": "int", "max": 4}}})
    check f.item.len == 1
    check f.item[0].`type` == ftList
    check f.item[0].item[0].`type` == ftInt
    check f.item[0].item[0].max == some(4)

  test "obj fields recurse and keep declaration order":
    let f = parseField(%*{"name": "p", "type": "obj", "fields": [
      {"name": "b", "type": "str", "optional": true},
      {"name": "a", "type": "obj", "fields": [{"name": "deep", "type": "bool"}]}]})
    check f.fields.len == 2
    check f.fields[0].name == "b" and f.fields[0].optional
    check f.fields[1].fields[0].name == "deep" and f.fields[1].fields[0].`type` == ftBool

  test "an unknown type nested inside item/fields still raises":
    expect ValueError:
      discard parseField(%*{"name": "l", "type": "list", "item": {"name": "l", "type": "nope"}})
    expect ValueError:
      discard parseField(%*{"name": "o", "type": "obj", "fields": [{"name": "x", "type": "nope"}]})

  test "a field with no name or no type raises KeyError":
    expect KeyError:
      discard parseField(%*{"type": "str"})
    expect KeyError:
      discard parseField(%*{"name": "n"})

suite "parse — parseAction":
  test "a bare action has no transition, no input and no transactional flag":
    let a = parseAction(%*{"name": "ping"})
    check a.name == "ping"
    check a.description.isNone and a.stateField.isNone and a.`from`.isNone and a.to.isNone
    check a.input.len == 0 and a.transactional.isNone

  test "transition, description and input are carried through":
    let a = parseAction(%*{"name": "activate", "description": "d", "stateField": "status", "from": "off", "to": "on",
                           "input": [{"name": "reason", "type": "str", "optional": true, "nullable": true}]})
    check a.description == some("d")
    check a.stateField == some("status") and a.`from` == some("off") and a.to == some("on")
    check a.input.len == 1 and a.input[0].optional and a.input[0].nullable

  test "transactional distinguishes false, true and absent":
    check parseAction(%*{"name": "a", "transactional": false}).transactional == some(false)
    check parseAction(%*{"name": "a", "transactional": true}).transactional == some(true)
    check parseAction(%*{"name": "a"}).transactional.isNone

  test "an empty input array yields no input fields":
    check parseAction(%*{"name": "a", "input": []}).input.len == 0

suite "parse — parseSecurity":
  test "apiKey scheme with no ops/actions":
    let s = parseSecurity(%*{"schemes": [{"name": "key", "type": "apiKey", "in": "header", "paramName": "X-Api-Key"}]})
    check s.schemes.len == 1
    check s.schemes[0].name == "key" and s.schemes[0].`type` == "apiKey"
    check s.schemes[0].`in` == some("header") and s.schemes[0].paramName == some("X-Api-Key")
    check s.schemes[0].scheme.isNone and s.schemes[0].bearerFormat.isNone
    check s.ops.len == 0 and s.actions.len == 0

  test "several schemes keep order; http basic has no bearerFormat":
    let s = parseSecurity(%*{"schemes": [{"name": "basic", "type": "http", "scheme": "basic"},
                                         {"name": "jwt", "type": "http", "scheme": "bearer", "bearerFormat": "JWT"}]})
    check s.schemes.len == 2
    check s.schemes[0].name == "basic" and s.schemes[0].scheme == some("basic") and s.schemes[0].bearerFormat.isNone
    check s.schemes[1].bearerFormat == some("JWT")

  test "scope maps keep key order, multiple scopes and empty scope lists":
    let s = parseSecurity(%*{"schemes": [{"name": "b", "type": "http", "scheme": "bearer"}],
                             "ops": {"list": [], "create": ["a:write", "a:admin"]},
                             "actions": {"archive": ["a:admin"]}})
    check s.ops.len == 2
    check s.ops[0].key == "list" and s.ops[0].scopes.len == 0
    check s.ops[1].key == "create" and s.ops[1].scopes == @["a:write", "a:admin"]
    check s.actions == @[("archive", @["a:admin"])]

  test "empty schemes array parses to no schemes; missing schemes raises KeyError":
    check parseSecurity(%*{"schemes": []}).schemes.len == 0
    expect KeyError:
      discard parseSecurity(%*{"ops": {}})

suite "parse — parseEntitySpec":
  let minimal = %*{"specVersion": "1.2.0", "entity": "Note", "path": "notes", "transports": ["rest"],
                   "ops": ["get"], "pagination": "cursor", "fields": []}

  test "minimal spec: no description, tags, security, fields or actions":
    let e = parseEntitySpec(minimal)
    check e.specVersion == "1.2.0" and e.entity == "Note" and e.path == "notes"
    check e.transports == @["rest"] and e.ops == @["get"] and e.pagination == "cursor"
    check e.description.isNone and e.tags.isNone and e.security.isNone
    check e.fields.len == 0 and e.actions.len == 0

  test "an explicit empty tags array is some(@[]), not none":
    var j = minimal.copy
    j["tags"] = %*[]
    let e = parseEntitySpec(j)
    check e.tags.isSome
    check e.tags.get.len == 0

  test "full spec round-trips through toJson unchanged":
    let j = %*{"specVersion": "1.2.0", "entity": "Doc", "path": "docs", "transports": ["rest", "ws"],
               "ops": ["list", "create"], "pagination": "offset", "description": "A doc", "tags": ["b", "a"],
               "security": {"schemes": [{"name": "key", "type": "apiKey", "in": "query", "paramName": "k"}],
                            "ops": {"create": ["doc:write"]}, "actions": {"publish": []}},
               "fields": [{"name": "id", "type": "str", "role": "id", "readonly": true},
                          {"name": "kind", "type": "enum", "enum": ["x", "y"], "filterable": true},
                          {"name": "parts", "type": "list", "item": {"name": "parts", "type": "obj", "fields": [
                            {"name": "n", "type": "int", "min": 0}]}},
                          {"name": "owner", "type": "ref", "ref": "User", "nullable": true}],
               "actions": [{"name": "publish", "stateField": "kind", "from": "x", "to": "y", "transactional": false,
                            "input": [{"name": "at", "type": "datetime", "optional": true}]}]}
    let e = parseEntitySpec(j)
    check e.description == some("A doc")
    check e.tags == some(@["b", "a"])
    check e.security.get.schemes[0].paramName == some("k")
    check e.fields.len == 4 and e.actions.len == 1
    check canonicalJson(toJson(e)) == canonicalJson(j)

  test "missing required keys raise KeyError":
    for k in ["specVersion", "entity", "path", "transports", "ops", "pagination", "fields"]:
      var j = minimal.copy
      j.delete(k)
      expect KeyError:
        discard parseEntitySpec(j)

  test "an unknown field type anywhere in the spec raises ValueError":
    var j = minimal.copy
    j["actions"] = %*[{"name": "a", "input": [{"name": "x", "type": "uuid"}]}]
    expect ValueError:
      discard parseEntitySpec(j)

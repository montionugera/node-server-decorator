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

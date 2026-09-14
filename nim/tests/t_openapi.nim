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

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

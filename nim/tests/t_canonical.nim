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
    check canonicalJson(%"a <b> & c é  ") == "\"a <b> & c é  \""
  test "control chars: short forms + LOWERCASE \\u00xx like JSON.stringify (not escapeJson's \\u001F)":
    check canonicalJson(%"\x1f\x0e\x01\b\t\n\r\f\"\\/") == "\"\\u001f\\u000e\\u0001\\b\\t\\n\\r\\f\\\"\\\\/\""
  for f in ["contracts/fixtures/entity-spec.valid-user.json", "contracts/fixtures/openapi.valid-user.json",
            "go/entity/testdata/html-escape.json"]:
    test "round-trips " & f & " byte-identically":
      let raw = readFile(root / f)
      check canonicalJson(parseJson(raw)) == raw

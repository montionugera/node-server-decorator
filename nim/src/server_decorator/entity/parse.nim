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

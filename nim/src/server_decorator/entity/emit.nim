## EntitySpec → JsonNode with the same omit rules as node/packages/entity (restful.ts, fields.ts, action.ts).
import std/[json, options]
import ./types, ./canonical

proc putOpt[T](n: JsonNode, key: string, v: Option[T]) =
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
  result.putOpt("tags", e.tags)
  if e.security.isSome: result["security"] = toJson(e.security.get)
  var fs = newJArray()
  for f in e.fields: fs.add toJson(f)
  result["fields"] = fs
  if e.actions.len > 0:
    var acts = newJArray()
    for a in e.actions: acts.add toJson(a)
    result["actions"] = acts

proc canonical*(e: EntitySpec): string = canonicalJson(toJson(e))

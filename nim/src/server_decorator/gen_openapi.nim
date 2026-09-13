## Straight port of node/packages/gen-openapi/src (map-field, components, paths, document, patterns).
## Output goes through entity/canonical so the document is byte-identical to the Node/Python twins.
import std/[json, options, algorithm, sequtils, strutils]
import ./entity/types, ./entity/canonical
export canonical

# --- patterns.ts (copied verbatim; the JS `.source` keeps `/` unescaped and `\/` as written) ---
const EmailPattern* = "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
const UuidPattern* = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
const UriPattern* = "^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s]+$"

type Keep* = proc(f: FieldSpec): bool
proc keepAll*(f: FieldSpec): bool = true

# --- map-field.ts ---
proc baseType(t: FieldType): string =
  case t
  of ftStr, ftRef, ftDatetime, ftEnum: "string"
  of ftInt: "integer"
  of ftFloat: "number"
  of ftBool: "boolean"
  of ftList: "array"
  of ftObj: "object"

proc formatPattern(f: string): string =
  case f
  of "email": EmailPattern
  of "uuid": UuidPattern
  of "uri": UriPattern
  else: raise newException(ValueError, "unknown format: " & f)

proc objectProperties*(fields: seq[FieldSpec], keep: Keep): JsonNode
proc jsonSchemaForField*(f: FieldSpec, keep: Keep = keepAll): JsonNode =
  let base = baseType(f.`type`)
  result = newJObject()
  result["type"] = (if f.nullable: %*[base, "null"] else: %base)
  if f.`type` == ftDatetime: result["format"] = %"date-time"
  if f.`type` in {ftStr, ftRef}:
    if f.format.isSome:
      result["format"] = %f.format.get
      result["pattern"] = %formatPattern(f.format.get)
    if f.pattern.isSome: result["pattern"] = %f.pattern.get
    if f.min.isSome: result["minLength"] = %f.min.get
    if f.max.isSome: result["maxLength"] = %f.max.get
  if f.`type` in {ftInt, ftFloat}:
    if f.min.isSome: result["minimum"] = %f.min.get
    if f.max.isSome: result["maximum"] = %f.max.get
  if f.`type` == ftEnum and f.`enum`.len > 0: result["enum"] = %f.`enum`
  if f.`type` == ftList:
    result["items"] = (if f.item.len > 0: jsonSchemaForField(f.item[0], keep) else: newJObject())
    if f.min.isSome: result["minItems"] = %f.min.get
    if f.max.isSome: result["maxItems"] = %f.max.get
  if f.`type` == ftObj:
    let kept = f.fields.filter(keep)
    result["properties"] = objectProperties(kept, keep)
    let required = kept.filterIt(not it.optional).mapIt(it.name)
    if required.len > 0: result["required"] = %required
    result["additionalProperties"] = %false
  if f.description.isSome: result["description"] = %f.description.get

proc objectProperties*(fields: seq[FieldSpec], keep: Keep): JsonNode =
  result = newJObject()
  for f in fields.filter(keep): result[f.name] = jsonSchemaForField(f, keep)

# --- components.ts ---
proc capitalize*(s: string): string =
  if s.len == 0: "" else: s[0].toUpperAscii & s[1..^1]

proc strictObject(fields: seq[FieldSpec], keep: Keep): JsonNode =
  let kept = fields.filter(keep)
  result = %*{"type": "object", "properties": objectProperties(kept, keep)}
  let required = kept.filterIt(not it.optional).mapIt(it.name)
  if required.len > 0: result["required"] = %required
  result["additionalProperties"] = %false

proc listEnvelope(entity, pagination: string): JsonNode =
  let items = %*{"type": "array", "items": {"$ref": "#/components/schemas/" & entity & "Read"}}
  let limit = %*{"type": "integer", "minimum": 1, "maximum": 100}
  if pagination == "cursor":
    return %*{"type": "object",
      "properties": {"items": items, "nextCursor": {"type": ["string", "null"]}},
      "required": ["items", "nextCursor"], "additionalProperties": false}
  %*{"type": "object",
    "properties": {"items": items, "total": {"type": "integer", "minimum": 0}, "limit": limit,
                   "offset": {"type": "integer", "minimum": 0}},
    "required": ["items", "total", "limit", "offset"], "additionalProperties": false}

proc problemSchemas*(): JsonNode = %*{
  "Problem": {"type": "object",
    "properties": {"type": {"type": "string", "format": "uri"}, "title": {"type": "string"},
                   "status": {"type": "integer"}, "detail": {"type": "string"},
                   "instance": {"type": "string", "format": "uri"}},
    "required": ["type", "title", "status"], "additionalProperties": false},
  "ValidationProblem": {"type": "object",
    "properties": {"type": {"type": "string", "format": "uri"}, "title": {"type": "string"},
                   "status": {"type": "integer"}, "detail": {"type": "string"},
                   "instance": {"type": "string", "format": "uri"},
                   "fields": {"type": "array", "items": {"type": "string"}}},
    "required": ["type", "title", "status", "fields"], "additionalProperties": false}}

proc schemeObject(s: SecurityScheme): JsonNode =
  if s.`type` == "apiKey":
    return %*{"type": "apiKey", "in": s.`in`.get(""), "name": s.paramName.get("")}
  result = %*{"type": "http", "scheme": s.scheme.get("")}
  if s.bearerFormat.isSome: result["bearerFormat"] = %s.bearerFormat.get

proc openapiComponents*(spec: EntitySpec): tuple[schemas, securitySchemes: JsonNode] =
  let e = spec.entity
  let create = strictObject(spec.fields, proc(f: FieldSpec): bool = not f.readonly)
  var update = create.copy
  if update.hasKey("required"): update.delete("required")
  var schemas = newJObject()
  schemas[e & "Create"] = create
  schemas[e & "Update"] = update
  schemas[e & "Read"] = strictObject(spec.fields, proc(f: FieldSpec): bool = not f.writeonly)
  schemas[e & "ListResponse"] = listEnvelope(e, spec.pagination)
  for a in spec.actions:
    schemas[e & capitalize(a.name) & "Input"] = strictObject(a.input, keepAll)
  var securitySchemes = newJObject()
  if spec.security.isSome:
    for s in spec.security.get.schemes: securitySchemes[s.name] = schemeObject(s)
  (schemas, securitySchemes)

# --- paths.ts ---
proc problem(status, description: string, component = "Problem"): (string, JsonNode) =
  (status, %*{"description": description,
    "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/" & component}}}})

proc jsonBody(refName: string): JsonNode =
  %*{"content": {"application/json": {"schema": {"$ref": "#/components/schemas/" & refName}}}}

proc idField(spec: EntitySpec): FieldSpec =
  for f in spec.fields:
    if f.role == some("id"): return f
  raise newException(ValueError, spec.entity & ": no field with role \"id\"")

proc securityFor(spec: EntitySpec, key: string, kind: string): Option[JsonNode] =
  if spec.security.isNone: return none(JsonNode)
  let sec = spec.security.get
  let entries = (if kind == "ops": sec.ops else: sec.actions)
  for (k, scopes) in entries:
    if k == key:
      if sec.schemes.len == 0: return none(JsonNode)
      var node = newJObject()
      node[sec.schemes[0].name] = %scopes
      return some(%*[node])
  none(JsonNode)

proc filterParams(spec: EntitySpec): seq[JsonNode] =
  for f in spec.fields:
    if f.filterable:
      var rest = f
      rest.optional = false; rest.nullable = false
      result.add %*{"name": f.name, "in": "query", "required": false, "schema": jsonSchemaForField(rest)}

proc paginationParams(spec: EntitySpec): seq[JsonNode] =
  let limit = %*{"name": "limit", "in": "query", "required": false,
                 "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}
  if spec.pagination == "cursor":
    return @[limit, %*{"name": "cursor", "in": "query", "required": false, "schema": {"type": "string"}}]
  @[limit, %*{"name": "offset", "in": "query", "required": false,
              "schema": {"type": "integer", "minimum": 0, "default": 0}}]

proc op(spec: EntitySpec, operationId: string, extra: JsonNode, responses: seq[(string, JsonNode)],
        security: Option[JsonNode]): JsonNode =
  result = newJObject()
  if spec.tags.isSome: result["tags"] = %spec.tags.get
  result["operationId"] = %operationId
  for k, v in extra.pairs: result[k] = v
  var resp = newJObject()
  for (code, body) in responses: resp[code] = body
  result["responses"] = resp
  if security.isSome: result["security"] = security.get

proc openapiPaths*(spec: EntitySpec): JsonNode =
  let e = spec.entity
  let base = "/" & spec.path
  let id = idField(spec)
  var idNoRole = id
  idNoRole.role = none(string)
  let idParam = %*{"name": id.name, "in": "path", "required": true, "schema": jsonSchemaForField(idNoRole)}
  result = newJObject()
  var collection = newJObject()
  var item = newJObject()
  let ok200 = proc(refName: string): (string, JsonNode) =
    var r = %*{"description": "OK"}
    for k, v in jsonBody(refName).pairs: r[k] = v
    ("200", r)
  if "list" in spec.ops:
    var params = paginationParams(spec) & filterParams(spec)
    params.sort(proc(a, b: JsonNode): int = cmp(a["name"].getStr, b["name"].getStr))
    var responses = @[ok200(e & "ListResponse")]
    if filterParams(spec).len > 0: responses.add problem("400", "Bad Request", "ValidationProblem")
    collection["get"] = op(spec, "list" & e, %*{"parameters": params}, responses, securityFor(spec, "list", "ops"))
  if "create" in spec.ops:
    var body = %*{"required": true}
    for k, v in jsonBody(e & "Create").pairs: body[k] = v
    var created = %*{"description": "Created"}
    for k, v in jsonBody(e & "Read").pairs: created[k] = v
    collection["post"] = op(spec, "create" & e, %*{"requestBody": body},
      @[("201", created), problem("400", "Bad Request", "ValidationProblem")], securityFor(spec, "create", "ops"))
  if "get" in spec.ops:
    item["get"] = op(spec, "get" & e, %*{"parameters": [idParam]},
      @[ok200(e & "Read"), problem("404", "Not Found")], securityFor(spec, "get", "ops"))
  if "update" in spec.ops:
    var body = %*{"required": true}
    for k, v in jsonBody(e & "Update").pairs: body[k] = v
    item["patch"] = op(spec, "update" & e, %*{"parameters": [idParam], "requestBody": body},
      @[ok200(e & "Read"), problem("400", "Bad Request", "ValidationProblem"), problem("404", "Not Found")],
      securityFor(spec, "update", "ops"))
  if "delete" in spec.ops:
    item["delete"] = op(spec, "delete" & e, %*{"parameters": [idParam]},
      @[("204", %*{"description": "No Content"}), problem("404", "Not Found")], securityFor(spec, "delete", "ops"))
  if collection.len > 0: result[base] = collection
  if item.len > 0: result[base & "/{" & id.name & "}"] = item
  for a in spec.actions:
    var extra = %*{"parameters": [idParam]}
    if a.description.isSome: extra["description"] = %a.description.get
    var body = %*{"required": true}
    for k, v in jsonBody(e & capitalize(a.name) & "Input").pairs: body[k] = v
    extra["requestBody"] = body
    var responses = @[ok200(e & "Read"), problem("400", "Bad Request", "ValidationProblem"), problem("404", "Not Found")]
    if a.`from`.isSome: responses.add problem("409", "Conflict")
    var post = newJObject()
    post["post"] = op(spec, a.name & e, extra, responses, securityFor(spec, a.name, "actions"))
    result[base & "/{" & id.name & "}/actions/" & a.name] = post

# --- document.ts ---
proc openapiDocument*(specs: seq[EntitySpec], version: string): JsonNode =
  var schemas = problemSchemas()
  var securitySchemes = newJObject()
  var paths = newJObject()
  var tagNames: seq[string]
  for spec in specs:
    let c = openapiComponents(spec)
    for k, v in c.schemas.pairs: schemas[k] = v
    for k, v in c.securitySchemes.pairs: securitySchemes[k] = v
    for k, v in openapiPaths(spec).pairs: paths[k] = v
    if spec.tags.isSome:
      for t in spec.tags.get:
        if t notin tagNames: tagNames.add t
  result = %*{"openapi": "3.1.0", "info": {"title": "server-decorator API", "version": version},
              "paths": paths, "components": {"schemas": schemas}}
  if tagNames.len > 0:
    tagNames.sort()
    result["tags"] = %tagNames.mapIt(%*{"name": it})
  if securitySchemes.len > 0: result["components"]["securitySchemes"] = securitySchemes

proc openapiCanonical*(specs: seq[EntitySpec], version: string): string =
  canonicalJson(openapiDocument(specs, version))

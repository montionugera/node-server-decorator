## Direct coverage for gen_openapi.nim: the exported helpers (keepAll, jsonSchemaForField,
## objectProperties, capitalize, problemSchemas) and the openapiComponents / openapiPaths /
## openapiDocument entry points on shapes the User fixture and cases.json do not exercise.
import std/[unittest, json, options, strutils]
import server_decorator/entity, server_decorator/gen_openapi

proc fld(name: string, t: FieldType): FieldSpec = FieldSpec(name: name, `type`: t)
proc idFld(): FieldSpec = FieldSpec(name: "id", `type`: ftStr, role: some("id"), readonly: true)
proc notSecret(f: FieldSpec): bool = f.name != "secret"

proc spec(fields: seq[FieldSpec], ops = @["list", "get", "create", "update", "delete"],
          pagination = "offset"): EntitySpec =
  EntitySpec(specVersion: SpecVersion, entity: "Note", path: "notes", transports: @["rest"], ops: ops,
             pagination: pagination, fields: fields)

proc refOf(n: JsonNode): string =
  ## schema $ref of a JSON (or problem+json) body
  for _, media in n["content"].pairs: return media["schema"]["$ref"].getStr

suite "gen_openapi — jsonSchemaForField":
  test "keepAll keeps any field, including readonly and writeonly ones":
    check keepAll(FieldSpec(name: "a", `type`: ftStr, readonly: true, writeonly: true))
    check keepAll(FieldSpec())

  test "scalar base types":
    check jsonSchemaForField(fld("a", ftStr)) == %*{"type": "string"}
    check jsonSchemaForField(fld("a", ftInt)) == %*{"type": "integer"}
    check jsonSchemaForField(fld("a", ftFloat)) == %*{"type": "number"}
    check jsonSchemaForField(fld("a", ftBool)) == %*{"type": "boolean"}
    check jsonSchemaForField(fld("a", ftRef)) == %*{"type": "string"}
    check jsonSchemaForField(fld("a", ftDatetime)) == %*{"type": "string", "format": "date-time"}

  test "nullable widens type to [base, null] for every base":
    var f = fld("a", ftInt)
    f.nullable = true
    check jsonSchemaForField(f)["type"] == %*["integer", "null"]
    f.`type` = ftDatetime
    check jsonSchemaForField(f) == %*{"type": ["string", "null"], "format": "date-time"}
    f.`type` = ftObj
    check jsonSchemaForField(f)["type"] == %*["object", "null"]

  test "each known format emits its own pattern":
    for (name, pat) in [("email", EmailPattern), ("uuid", UuidPattern), ("uri", UriPattern)]:
      var f = fld("a", ftStr)
      f.format = some(name)
      check jsonSchemaForField(f) == %*{"type": "string", "format": name, "pattern": pat}

  test "format applies to ref fields too":
    var f = fld("owner", ftRef)
    f.format = some("uuid")
    check jsonSchemaForField(f)["pattern"].getStr == UuidPattern

  test "an unknown or empty format raises ValueError naming it":
    for bad in ["date", "", "Email"]:
      var f = fld("a", ftStr)
      f.format = some(bad)
      var msg = ""
      try:
        discard jsonSchemaForField(f)
      except ValueError as e:
        msg = e.msg
      check msg == "unknown format: " & bad

  test "format is ignored on non-string types (no raise, no key)":
    var f = fld("a", ftInt)
    f.format = some("bogus")
    f.pattern = some("^x$")
    check jsonSchemaForField(f) == %*{"type": "integer"}

  test "explicit pattern is emitted without a format key":
    var f = fld("a", ftStr)
    f.pattern = some("^[a-z]+$")
    check jsonSchemaForField(f) == %*{"type": "string", "pattern": "^[a-z]+$"}

  test "string bounds become minLength/maxLength; zero survives":
    var f = fld("a", ftStr)
    f.min = some(0); f.max = some(0)
    check jsonSchemaForField(f) == %*{"type": "string", "minLength": 0, "maxLength": 0}

  test "numeric bounds become minimum/maximum; zero and negatives survive":
    var f = fld("a", ftInt)
    f.min = some(-3); f.max = some(0)
    check jsonSchemaForField(f) == %*{"type": "integer", "minimum": -3, "maximum": 0}
    f.`type` = ftFloat
    f.max = none(int)
    check jsonSchemaForField(f) == %*{"type": "number", "minimum": -3}

  test "bounds are dropped on types that have none (bool, enum, datetime)":
    for t in [ftBool, ftDatetime]:
      var f = fld("a", t)
      f.min = some(1); f.max = some(2)
      let j = jsonSchemaForField(f)
      for k in ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]: check not j.hasKey(k)

  test "enum emits its values in order; an empty enum emits no enum key":
    var f = fld("s", ftEnum)
    f.`enum` = @["b", "a"]
    check jsonSchemaForField(f) == %*{"type": "string", "enum": ["b", "a"]}
    f.`enum` = @[]
    check jsonSchemaForField(f) == %*{"type": "string"}

  test "list: items from item[0], bounds as minItems/maxItems":
    var f = fld("tags", ftList)
    f.item = @[fld("tags", ftInt)]
    f.min = some(1); f.max = some(5)
    check jsonSchemaForField(f) == %*{"type": "array", "items": {"type": "integer"}, "minItems": 1, "maxItems": 5}

  test "list with no item falls back to an empty items schema":
    check jsonSchemaForField(fld("tags", ftList)) == %*{"type": "array", "items": {}}

  test "obj: properties, required lists only non-optional members, additionalProperties false":
    var f = fld("p", ftObj)
    var bio = fld("bio", ftStr)
    bio.optional = true
    f.fields = @[fld("age", ftInt), bio]
    check jsonSchemaForField(f) == %*{"type": "object",
      "properties": {"age": {"type": "integer"}, "bio": {"type": "string"}},
      "required": ["age"], "additionalProperties": false}

  test "obj whose members are all optional (or absent) has no required key":
    var f = fld("p", ftObj)
    check jsonSchemaForField(f) == %*{"type": "object", "properties": {}, "additionalProperties": false}
    var bio = fld("bio", ftStr)
    bio.optional = true
    f.fields = @[bio]
    check not jsonSchemaForField(f).hasKey("required")

  test "keep filters nested obj members recursively, through list items too":
    var inner = fld("inner", ftObj)
    inner.fields = @[fld("secret", ftStr), fld("shown", ftStr)]
    var lst = fld("rows", ftList)
    lst.item = @[inner]
    var outer = fld("outer", ftObj)
    outer.fields = @[fld("secret", ftStr), lst]
    let j = jsonSchemaForField(outer, notSecret)
    check j["required"] == %*["rows"]
    check not j["properties"].hasKey("secret")
    let rowSchema = j["properties"]["rows"]["items"]
    check rowSchema["required"] == %*["shown"]
    check not rowSchema["properties"].hasKey("secret")

  test "description is emitted on any type":
    var f = fld("a", ftBool)
    f.description = some("flag")
    check jsonSchemaForField(f) == %*{"type": "boolean", "description": "flag"}

suite "gen_openapi — objectProperties / capitalize / problemSchemas":
  test "objectProperties maps kept fields by name and drops the rest":
    let props = objectProperties(@[fld("a", ftInt), fld("secret", ftStr), fld("b", ftBool)], notSecret)
    check props == %*{"a": {"type": "integer"}, "b": {"type": "boolean"}}

  test "objectProperties of no fields is an empty object":
    let props = objectProperties(@[], keepAll)
    check props.kind == JObject and props.len == 0

  test "capitalize: empty, single char, already upper, non-letter first char":
    check capitalize("") == ""
    check capitalize("a") == "A"
    check capitalize("activate") == "Activate"
    check capitalize("Activate") == "Activate"
    check capitalize("markAsRead") == "MarkAsRead"
    check capitalize("1st") == "1st"
    check capitalize("_x") == "_x"

  test "problemSchemas: ValidationProblem is Problem plus a required string-array `fields`":
    let p = problemSchemas()
    check p.len == 2
    check p["Problem"]["required"] == %*["type", "title", "status"]
    check not p["Problem"]["properties"].hasKey("fields")
    check p["ValidationProblem"]["required"] == %*["type", "title", "status", "fields"]
    check p["ValidationProblem"]["properties"]["fields"] == %*{"type": "array", "items": {"type": "string"}}
    check p["Problem"]["additionalProperties"] == %false

  test "problemSchemas returns a fresh tree each call (mutating one does not leak)":
    let a = problemSchemas()
    a["Problem"]["title"] = %"mutated"
    check not problemSchemas()["Problem"].hasKey("title")

suite "gen_openapi — openapiComponents":
  test "Create drops readonly, Read drops writeonly, Update is Create without required":
    var pw = fld("password", ftStr)
    pw.writeonly = true
    var nick = fld("nick", ftStr)
    nick.optional = true
    let c = openapiComponents(spec(@[idFld(), pw, nick]))
    check c.schemas["NoteCreate"] == %*{"type": "object",
      "properties": {"password": {"type": "string"}, "nick": {"type": "string"}},
      "required": ["password"], "additionalProperties": false}
    check c.schemas["NoteUpdate"] == %*{"type": "object",
      "properties": {"password": {"type": "string"}, "nick": {"type": "string"}}, "additionalProperties": false}
    check c.schemas["NoteRead"]["required"] == %*["id"]
    check not c.schemas["NoteRead"]["properties"].hasKey("password")
    check c.securitySchemes.len == 0

  test "Create with only optional writable fields has no required; Update equals it":
    var nick = fld("nick", ftStr)
    nick.optional = true
    let c = openapiComponents(spec(@[idFld(), nick]))
    check not c.schemas["NoteCreate"].hasKey("required")
    check c.schemas["NoteUpdate"] == c.schemas["NoteCreate"]

  test "a spec with no fields still yields four strict empty schemas":
    let c = openapiComponents(spec(@[]))
    check c.schemas.len == 4
    check c.schemas["NoteRead"] == %*{"type": "object", "properties": {}, "additionalProperties": false}

  test "offset list envelope":
    let env = openapiComponents(spec(@[idFld()])).schemas["NoteListResponse"]
    check env["required"] == %*["items", "total", "limit", "offset"]
    check env["properties"]["items"]["items"]["$ref"].getStr == "#/components/schemas/NoteRead"
    check env["properties"]["limit"] == %*{"type": "integer", "minimum": 1, "maximum": 100}
    check env["properties"]["offset"]["minimum"] == %0

  test "cursor list envelope has nextCursor and no total/limit/offset":
    let env = openapiComponents(spec(@[idFld()], pagination = "cursor")).schemas["NoteListResponse"]
    check env["required"] == %*["items", "nextCursor"]
    check env["properties"]["nextCursor"] == %*{"type": ["string", "null"]}
    for k in ["total", "limit", "offset"]: check not env["properties"].hasKey(k)
    check env["additionalProperties"] == %false

  test "each action gets a <Entity><Action>Input schema; no-input action is a strict empty object":
    var s = spec(@[idFld()])
    var reason = fld("reason", ftStr)
    reason.readonly = true   # action inputs use keepAll: readonly must NOT be filtered
    s.actions = @[ActionSpec(name: "archive", input: @[reason]), ActionSpec(name: "ping")]
    let c = openapiComponents(s)
    check c.schemas["NoteArchiveInput"] == %*{"type": "object", "properties": {"reason": {"type": "string"}},
                                              "required": ["reason"], "additionalProperties": false}
    check c.schemas["NotePingInput"] == %*{"type": "object", "properties": {}, "additionalProperties": false}

  test "security schemes: http with/without bearerFormat, apiKey, and missing optionals default to empty":
    var s = spec(@[idFld()])
    s.security = some(SecuritySpec(schemes: @[
      SecurityScheme(name: "jwt", `type`: "http", scheme: some("bearer"), bearerFormat: some("JWT")),
      SecurityScheme(name: "basic", `type`: "http", scheme: some("basic")),
      SecurityScheme(name: "key", `type`: "apiKey", `in`: some("header"), paramName: some("X-Key")),
      SecurityScheme(name: "bareKey", `type`: "apiKey"),
      SecurityScheme(name: "bareHttp", `type`: "http")]))
    let ss = openapiComponents(s).securitySchemes
    check ss["jwt"] == %*{"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
    check ss["basic"] == %*{"type": "http", "scheme": "basic"}
    check ss["key"] == %*{"type": "apiKey", "in": "header", "name": "X-Key"}
    check ss["bareKey"] == %*{"type": "apiKey", "in": "", "name": ""}
    check ss["bareHttp"] == %*{"type": "http", "scheme": ""}

suite "gen_openapi — openapiPaths":
  test "no field with role id raises ValueError naming the entity":
    var msg = ""
    try:
      discard openapiPaths(spec(@[fld("name", ftStr)]))
    except ValueError as e:
      msg = e.msg
    check msg == "Note: no field with role \"id\""

  test "all five ops: collection has get+post, item has get+patch+delete, keyed by the id field name":
    var key = FieldSpec(name: "slug", `type`: ftStr, role: some("id"))
    let p = openapiPaths(spec(@[key]))
    check p.len == 2
    check p["/notes"].len == 2 and p["/notes"].hasKey("get") and p["/notes"].hasKey("post")
    let item = p["/notes/{slug}"]
    check item.len == 3
    check item["get"]["operationId"].getStr == "getNote"
    check item["patch"]["operationId"].getStr == "updateNote"
    check item["delete"]["operationId"].getStr == "deleteNote"
    check item["get"]["parameters"] == %*[{"name": "slug", "in": "path", "required": true, "schema": {"type": "string"}}]

  test "response codes per op":
    let p = openapiPaths(spec(@[idFld()]))
    check p["/notes"]["post"]["responses"]["201"]["description"].getStr == "Created"
    check refOf(p["/notes"]["post"]["responses"]["201"]) == "#/components/schemas/NoteRead"
    check refOf(p["/notes"]["post"]["responses"]["400"]) == "#/components/schemas/ValidationProblem"
    check p["/notes"]["post"]["requestBody"]["required"] == %true
    check refOf(p["/notes"]["post"]["requestBody"]) == "#/components/schemas/NoteCreate"
    check refOf(p["/notes/{id}"]["patch"]["requestBody"]) == "#/components/schemas/NoteUpdate"
    check refOf(p["/notes/{id}"]["get"]["responses"]["404"]) == "#/components/schemas/Problem"
    check p["/notes/{id}"]["delete"]["responses"]["204"] == %*{"description": "No Content"}
    check not p["/notes/{id}"]["delete"]["responses"].hasKey("200")
    check p["/notes/{id}"]["patch"]["responses"].len == 3

  test "only item ops: no collection path":
    let p = openapiPaths(spec(@[idFld()], ops = @["get"]))
    check p.len == 1
    check p.hasKey("/notes/{id}") and not p.hasKey("/notes")
    check p["/notes/{id}"].len == 1

  test "only collection ops: no item path":
    let p = openapiPaths(spec(@[idFld()], ops = @["list"]))
    check p.len == 1
    check p.hasKey("/notes") and not p["/notes"].hasKey("post")

  test "no ops and no actions: empty paths object":
    let p = openapiPaths(spec(@[idFld()], ops = @[]))
    check p.kind == JObject and p.len == 0

  test "list without filterable fields: limit+offset params and no 400":
    let get = openapiPaths(spec(@[idFld()]))["/notes"]["get"]
    check get["parameters"].len == 2
    check get["parameters"][0] == %*{"name": "limit", "in": "query", "required": false,
      "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}}
    check get["parameters"][1]["name"].getStr == "offset"
    check get["parameters"][1]["schema"]["default"] == %0
    check not get["responses"].hasKey("400")
    check refOf(get["responses"]["200"]) == "#/components/schemas/NoteListResponse"

  test "cursor pagination swaps offset for a string cursor param":
    let params = openapiPaths(spec(@[idFld()], pagination = "cursor"))["/notes"]["get"]["parameters"]
    check params.len == 2
    check params[0] == %*{"name": "cursor", "in": "query", "required": false, "schema": {"type": "string"}}
    check params[1]["name"].getStr == "limit"

  test "filterable fields: params sorted by name with pagination, nullable/optional stripped, 400 added":
    var zed = FieldSpec(name: "zed", `type`: ftInt, filterable: true, nullable: true, optional: true, min: some(0))
    var alpha = FieldSpec(name: "alpha", `type`: ftEnum, `enum`: @["x", "y"], filterable: true)
    let get = openapiPaths(spec(@[idFld(), zed, alpha, fld("plain", ftStr)]))["/notes"]["get"]
    var names: seq[string]
    for prm in get["parameters"]: names.add prm["name"].getStr
    check names == @["alpha", "limit", "offset", "zed"]
    check get["parameters"][3] == %*{"name": "zed", "in": "query", "required": false,
                                     "schema": {"type": "integer", "minimum": 0}}
    check get["parameters"][0]["schema"] == %*{"type": "string", "enum": ["x", "y"]}
    check refOf(get["responses"]["400"]) == "#/components/schemas/ValidationProblem"

  test "tags are stamped on every operation; absent tags emit no key; some(@[]) emits []":
    var s = spec(@[idFld()])
    check not openapiPaths(s)["/notes"]["get"].hasKey("tags")
    s.tags = some(@["b", "a"])
    s.actions = @[ActionSpec(name: "ping")]
    let p = openapiPaths(s)
    check p["/notes"]["get"]["tags"] == %*["b", "a"]
    check p["/notes/{id}"]["delete"]["tags"] == %*["b", "a"]
    check p["/notes/{id}/actions/ping"]["post"]["tags"] == %*["b", "a"]
    s.tags = some(newSeq[string]())
    check openapiPaths(s)["/notes"]["get"]["tags"] == %*[]

  test "security: only ops/actions with an entry get a requirement, using the FIRST scheme":
    var s = spec(@[idFld()])
    s.actions = @[ActionSpec(name: "archive"), ActionSpec(name: "ping")]
    s.security = some(SecuritySpec(
      schemes: @[SecurityScheme(name: "jwt", `type`: "http", scheme: some("bearer")),
                 SecurityScheme(name: "key", `type`: "apiKey", `in`: some("header"), paramName: some("X"))],
      ops: @[("delete", @["note:admin", "note:write"]), ("list", newSeq[string]())],
      actions: @[("archive", @["note:admin"])]))
    let p = openapiPaths(s)
    check p["/notes/{id}"]["delete"]["security"] == %*[{"jwt": ["note:admin", "note:write"]}]
    check p["/notes"]["get"]["security"] == %*[{"jwt": []}]
    check not p["/notes"]["post"].hasKey("security")
    check not p["/notes/{id}"]["get"].hasKey("security")
    check p["/notes/{id}/actions/archive"]["post"]["security"] == %*[{"jwt": ["note:admin"]}]
    check not p["/notes/{id}/actions/ping"]["post"].hasKey("security")

  test "an op named only under security.actions (and vice versa) gets no requirement":
    var s = spec(@[idFld()])
    s.actions = @[ActionSpec(name: "list")]
    s.security = some(SecuritySpec(schemes: @[SecurityScheme(name: "jwt", `type`: "http", scheme: some("bearer"))],
                                   actions: @[("list", @["a"])]))
    let p = openapiPaths(s)
    check not p["/notes"]["get"].hasKey("security")
    check p["/notes/{id}/actions/list"]["post"]["security"] == %*[{"jwt": ["a"]}]

  test "a scope entry with no schemes declared yields no requirement":
    var s = spec(@[idFld()])
    s.security = some(SecuritySpec(ops: @[("delete", @["x"])]))
    check not openapiPaths(s)["/notes/{id}"]["delete"].hasKey("security")

  test "actions: path, operationId, input ref, description, and 409 only with a `from` state":
    var s = spec(@[idFld()], ops = @[])
    s.actions = @[
      ActionSpec(name: "activate", description: some("Wake up"), stateField: some("status"),
                 `from`: some("off"), to: some("on")),
      ActionSpec(name: "ping")]
    let p = openapiPaths(s)
    check p.len == 2   # no CRUD paths at all, just the two action paths
    let act = p["/notes/{id}/actions/activate"]["post"]
    check act["operationId"].getStr == "activateNote"
    check act["description"].getStr == "Wake up"
    check refOf(act["requestBody"]) == "#/components/schemas/NoteActivateInput"
    check act["requestBody"]["required"] == %true
    check act["parameters"][0]["name"].getStr == "id"
    check refOf(act["responses"]["409"]) == "#/components/schemas/Problem"
    check act["responses"]["409"]["description"].getStr == "Conflict"
    let ping = p["/notes/{id}/actions/ping"]["post"]
    check not ping.hasKey("description")
    check not ping["responses"].hasKey("409")
    check ping["responses"].len == 3

  test "the id path parameter keeps the id field's constraints":
    var key = FieldSpec(name: "id", `type`: ftStr, role: some("id"), format: some("uuid"))
    let prm = openapiPaths(spec(@[key], ops = @["get"]))["/notes/{id}"]["get"]["parameters"][0]
    check prm["schema"] == %*{"type": "string", "format": "uuid", "pattern": UuidPattern}

  test "the first field with role id wins":
    let a = FieldSpec(name: "a", `type`: ftInt, role: some("id"))
    let b = FieldSpec(name: "b", `type`: ftStr, role: some("id"))
    let p = openapiPaths(spec(@[fld("x", ftStr), a, b], ops = @["get"]))
    check p.hasKey("/notes/{a}")
    check p["/notes/{a}"]["get"]["parameters"][0]["schema"] == %*{"type": "integer"}

suite "gen_openapi — openapiDocument / openapiCanonical":
  test "no specs: header, empty paths, only the two problem schemas, no tags or securitySchemes":
    let d = openapiDocument(@[], "9.9.9")
    check d["openapi"].getStr == "3.1.0"
    check d["info"] == %*{"title": "server-decorator API", "version": "9.9.9"}
    check d["paths"].len == 0
    check d["components"]["schemas"].len == 2
    check not d.hasKey("tags")
    check not d["components"].hasKey("securitySchemes")

  test "several specs merge paths and schemas; tags are de-duplicated and sorted":
    var a = spec(@[idFld()])
    a.tags = some(@["zeta", "alpha"])
    var b = spec(@[idFld()], ops = @["get"])
    b.entity = "Task"; b.path = "tasks"
    b.tags = some(@["alpha", "mid"])
    b.security = some(SecuritySpec(schemes: @[SecurityScheme(name: "jwt", `type`: "http", scheme: some("bearer"))]))
    let d = openapiDocument(@[a, b], "1.0.0")
    check d["tags"] == %*[{"name": "alpha"}, {"name": "mid"}, {"name": "zeta"}]
    check d["paths"].len == 3
    check d["paths"].hasKey("/notes") and d["paths"].hasKey("/tasks/{id}")
    check d["components"]["schemas"].len == 2 + 4 + 4
    check d["components"]["schemas"].hasKey("TaskRead") and d["components"]["schemas"].hasKey("Problem")
    check d["components"]["securitySchemes"] == %*{"jwt": {"type": "http", "scheme": "bearer"}}

  test "an explicit empty tags list emits no top-level tags key":
    var a = spec(@[idFld()])
    a.tags = some(newSeq[string]())
    check not openapiDocument(@[a], "1.0.0").hasKey("tags")

  test "a spec with no id field makes the whole document fail":
    expect ValueError:
      discard openapiDocument(@[spec(@[fld("x", ftStr)])], "1.0.0")

  test "openapiCanonical is the canonical form of the document: sorted keys, no whitespace, stable":
    let s = spec(@[idFld()], ops = @["get"])
    let c = openapiCanonical(@[s], "1.0.0")
    check c == canonicalJson(openapiDocument(@[s], "1.0.0"))
    check c == openapiCanonical(@[s], "1.0.0")
    check parseJson(c) == openapiDocument(@[s], "1.0.0")
    check c[0 .. 13] == "{\"components\":"
    check '\n' notin c and "\": " notin c and ", \"" notin c

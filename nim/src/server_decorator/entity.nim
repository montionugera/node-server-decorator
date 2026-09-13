## `restful` block macro + field pragmas — the Nim analogue of @Restful/@restful.
import std/[macros, options, tables]
import ./entity/types, ./entity/emit, ./entity/canonical, ./entity/validate
export types, emit, canonical, validate, options

const Flags = ["optional", "nullable", "readonly", "writeonly", "filterable"]
const StrPragmas = ["description", "role", "format", "pattern", "refTo"]

proc pName(p: NimNode): string =
  case p.kind
  of nnkIdent, nnkSym: p.strVal
  of nnkExprColonExpr, nnkCall, nnkExprEqExpr: p[0].strVal
  else: error("unsupported pragma syntax: " & p.repr, p)

proc strLit(n: NimNode, what: string): NimNode =
  if n.kind notin {nnkStrLit, nnkTripleStrLit, nnkRStrLit}: error(what & " must be a string literal", n)
  n

proc someOf(n: NimNode): NimNode = newCall(ident"some", n)

# Build `FieldSpec(...)` for one `name {.pragmas.}: Type` declaration.
proc fieldCstr(nameNode, typeNode: NimNode, pragmas: NimNode, nested: Table[string, NimNode]): NimNode

proc typeToKind(t: NimNode, name: string, nested: Table[string, NimNode],
                cstr: var seq[NimNode]): string =
  ## Returns the FieldType enum name and appends item/fields entries to `cstr`.
  case t.kind
  of nnkIdent:
    case t.strVal
    of "string": "ftStr"
    of "int", "int64", "int32": "ftInt"
    of "float", "float64": "ftFloat"
    of "bool": "ftBool"
    of "DateTime", "Time": "ftDatetime"
    else:
      if t.strVal in nested:
        cstr.add newColonExpr(ident"fields", nested[t.strVal].copyNimTree)
        "ftObj"
      else:
        error("field '" & name & "': unknown type '" & t.strVal &
              "' — nested object types must be declared inside the same `restful` block", t)
  of nnkBracketExpr:
    if t[0].kind == nnkIdent and t[0].strVal == "seq":
      # list: item carries the SAME name at every nesting level (fields.ts injectListItemNames)
      let item = fieldCstr(ident(name), t[1], newEmptyNode(), nested)
      cstr.add newColonExpr(ident"item", nnkPrefix.newTree(ident"@", nnkBracket.newTree(item)))
      "ftList"
    else: error("field '" & name & "': unsupported type " & t.repr, t)
  else: error("field '" & name & "': unsupported type " & t.repr, t)

proc fieldCstr(nameNode, typeNode: NimNode, pragmas: NimNode, nested: Table[string, NimNode]): NimNode =
  let name = nameNode.strVal
  var cstr: seq[NimNode] = @[newColonExpr(ident"name", newLit(name))]
  var kind = typeToKind(typeNode, name, nested, cstr)
  var enumVals: NimNode = nil
  if pragmas.kind != nnkEmpty:
    for p in pragmas:
      let n = pName(p)
      if n in Flags:
        if p.kind != nnkIdent: error("field '" & name & "': flag '" & n & "' takes no value", p)
        cstr.add newColonExpr(ident(n), newLit(true))
      elif n in StrPragmas:
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr}: error("field '" & name & "': '" & n & "' needs a string value", p)
        let v = strLit(p[1], "field '" & name & "': " & n)
        if n == "refTo":
          kind = "ftRef"; cstr.add newColonExpr(ident"ref", someOf(v))
        else:
          cstr.add newColonExpr(ident(n), someOf(v))
      elif n in ["min", "max"]:
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr} or p[1].kind != nnkIntLit:
          error("field '" & name & "': '" & n & "' must be an integer literal (even on float fields)", p)
        cstr.add newColonExpr(ident(n), someOf(p[1]))
      elif n == "enumOf":
        if p.kind notin {nnkExprColonExpr, nnkExprEqExpr} or p[1].kind != nnkBracket or p[1].len == 0:
          error("field '" & name & "': enumOf needs a non-empty [\"a\", \"b\"] literal", p)
        for e in p[1]: discard strLit(e, "field '" & name & "': enumOf value")
        kind = "ftEnum"
        enumVals = nnkPrefix.newTree(ident"@", p[1].copyNimTree)
      else:
        error("unknown field pragma '" & n & "' on field '" & name & "'", p)
  cstr.add newColonExpr(ident"type", ident(kind))
  if enumVals != nil: cstr.add newColonExpr(ident"enum", enumVals)
  result = nnkObjConstr.newTree(ident"FieldSpec")
  for c in cstr: result.add c

proc splitIdentDefs(def: NimNode): tuple[name, pragmas: NimNode] =
  ## `name {.p.}: T` / `name* {.p.}: T` / `name: T` / `name*: T`
  var n = def[0]
  var pragmas = newEmptyNode()
  if n.kind == nnkPragmaExpr:
    pragmas = n[1]; n = n[0]
  if n.kind == nnkPostfix: n = n[1]
  (n, pragmas)

proc fieldsOfObject(td: NimNode, nested: Table[string, NimNode]): NimNode =
  ## `@[FieldSpec(...), ...]` for one object type def; also strips our pragmas from `td` in place.
  let obj = td[2]
  if obj.kind != nnkObjectTy: error("restful: only `object` types are supported", td)
  var arr = nnkBracket.newTree()
  let recList = obj[2]
  for i in 0 ..< recList.len:
    let def = recList[i]
    if def.kind != nnkIdentDefs: error("restful: unsupported field declaration", def)
    if def.len != 3: error("restful: declare one field per line", def)
    let (nameNode, pragmas) = splitIdentDefs(def)
    arr.add fieldCstr(nameNode, def[1], pragmas, nested)
    # strip pragmas so the emitted Nim type is plain
    if def[0].kind == nnkPragmaExpr: recList[i][0] = def[0][0]
  nnkPrefix.newTree(ident"@", arr)

proc parseAction(stmt: NimNode, nested: Table[string, NimNode]): NimNode =
  ## `action "name"[, description = "..."][, transactional = false]:` body with `transition`/`input`.
  var cstr: seq[NimNode] = @[]
  var body: NimNode = newEmptyNode()
  for i in 1 ..< stmt.len:
    let a = stmt[i]
    if a.kind == nnkStmtList: body = a
    elif i == 1: cstr.add newColonExpr(ident"name", strLit(a, "action name"))
    elif a.kind == nnkExprEqExpr and a[0].strVal == "description":
      cstr.add newColonExpr(ident"description", someOf(strLit(a[1], "action description")))
    elif a.kind == nnkExprEqExpr and a[0].strVal == "transactional":
      cstr.add newColonExpr(ident"transactional", someOf(a[1]))
    else: error("action: unexpected argument " & a.repr, a)
  if body.kind != nnkEmpty:
    for s in body:
      if s.kind in {nnkCommand, nnkCall} and s[0].strVal == "transition":
        if s.len != 4: error("transition needs (stateField, from, to)", s)
        cstr.add newColonExpr(ident"stateField", someOf(strLit(s[1], "transition stateField")))
        cstr.add newColonExpr(ident"from", someOf(strLit(s[2], "transition from")))
        cstr.add newColonExpr(ident"to", someOf(strLit(s[3], "transition to")))
      elif s.kind == nnkCall and s[0].strVal == "input":
        var arr = nnkBracket.newTree()
        for f in s[1]:
          # `reason {.max: 200, optional.}: string` parses as Call(PragmaExpr|Ident, StmtList(Type))
          if f.kind != nnkCall or f.len != 2: error("input: expected `name {.pragmas.}: Type`", f)
          var n = f[0]; var pragmas = newEmptyNode()
          if n.kind == nnkPragmaExpr: pragmas = n[1]; n = n[0]
          arr.add fieldCstr(n, f[1][0], pragmas, nested)
        cstr.add newColonExpr(ident"input", nnkPrefix.newTree(ident"@", arr))
      else: error("action body: expected `transition` or `input:`", s)
  result = nnkObjConstr.newTree(ident"ActionSpec")
  for c in cstr: result.add c

proc identList(n: NimNode, what: string): NimNode =
  if n.kind != nnkBracket or n.len == 0: error(what & " must be a non-empty [a, b] literal", n)
  var arr = nnkBracket.newTree()
  for e in n:
    if e.kind == nnkIdent: arr.add newLit(e.strVal)
    else: arr.add strLit(e, what)
  nnkPrefix.newTree(ident"@", arr)

macro restful*(path: string, args: varargs[untyped]): untyped =
  ## restful "users", description = "...", tags = ["x"], transports = [rest, rpc], ops = [list, get],
  ##                  pagination = cursor, security = SecuritySpec(...):
  ##   type <nested...>; <Entity> = object ...   # LAST type in the block is the entity
  ##   action "name", description = "...": transition ...; input: ...
  if args.len == 0 or args[^1].kind != nnkStmtList: error("restful: missing block body", path)
  let body = args[^1]
  var e: seq[NimNode] = @[newColonExpr(ident"specVersion", ident"SpecVersion"),
                          newColonExpr(ident"path", strLit(path, "restful path"))]
  var transports = nnkPrefix.newTree(ident"@", nnkBracket.newTree(newLit"rest"))
  var ops = nnkPrefix.newTree(ident"@", nnkBracket.newTree(newLit"list", newLit"get", newLit"create", newLit"update", newLit"delete"))
  var pagination = newLit"offset"
  for i in 0 ..< args.len - 1:
    let a = args[i]
    if a.kind != nnkExprEqExpr: error("restful: expected `name = value`", a)
    case a[0].strVal
    of "description": e.add newColonExpr(ident"description", someOf(strLit(a[1], "description")))
    of "tags": e.add newColonExpr(ident"tags", someOf(identList(a[1], "tags")))
    of "transports": transports = identList(a[1], "transports")
    of "ops": ops = identList(a[1], "ops")
    of "pagination": pagination = (if a[1].kind == nnkIdent: newLit(a[1].strVal) else: strLit(a[1], "pagination"))
    of "security": e.add newColonExpr(ident"security", someOf(a[1]))
    else: error("restful: unknown option '" & a[0].strVal & "'", a)
  e.add newColonExpr(ident"transports", transports)
  e.add newColonExpr(ident"ops", ops)
  e.add newColonExpr(ident"pagination", pagination)

  var typeSection: NimNode = nil
  var nested = initTable[string, NimNode]()
  var entityName = ""
  var fields: NimNode = nil
  var actions = nnkBracket.newTree()
  for stmt in body:
    case stmt.kind
    of nnkTypeSection:
      if typeSection != nil: error("restful: only one `type` section per block", stmt)
      typeSection = stmt
      for td in stmt:
        let nameNode = (if td[0].kind == nnkPragmaExpr: td[0][0] else: td[0])
        let tname = (if nameNode.kind == nnkPostfix: nameNode[1] else: nameNode).strVal
        let fs = fieldsOfObject(td, nested)
        nested[tname] = fs
        entityName = tname; fields = fs
    of nnkCommand, nnkCall:
      if stmt[0].kind == nnkIdent and stmt[0].strVal == "action": actions.add parseAction(stmt, nested)
      else: error("restful: unexpected statement " & stmt.repr, stmt)
    else: error("restful: unexpected statement " & stmt.repr, stmt)
  if typeSection == nil: error("restful: block needs a `type` section with the entity object", body)
  e.add newColonExpr(ident"entity", newLit(entityName))
  e.add newColonExpr(ident"fields", fields)
  if actions.len > 0: e.add newColonExpr(ident"actions", nnkPrefix.newTree(ident"@", actions))
  var cstr = nnkObjConstr.newTree(ident"EntitySpec")
  for c in e: cstr.add c
  let specSym = genSym(nskConst, entityName & "Spec")
  let entityIdent = ident(entityName)
  result = quote do:
    `typeSection`
    const `specSym` = block:
      let s = `cstr`
      validateEntitySpec(s)   # a ValueError here is a compile error carrying the message
      s
    template entitySpec*(_: typedesc[`entityIdent`]): EntitySpec = `specSym`
  when defined(restfulDebug): echo result.repr

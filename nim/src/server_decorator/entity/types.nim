## Typed EntitySpec IR — mirrors node/packages/entity/src/types.ts (specVersion 1.2.0).
import std/options

type
  FieldType* = enum
    ftStr = "str", ftInt = "int", ftFloat = "float", ftBool = "bool", ftDatetime = "datetime",
    ftEnum = "enum", ftRef = "ref", ftList = "list", ftObj = "obj"

  FieldSpec* = object
    name*: string
    `type`*: FieldType
    description*: Option[string]
    role*: Option[string]          # only "id"
    format*: Option[string]        # email | uuid | uri
    `enum`*: seq[string]           # emitted only for ftEnum
    min*, max*: Option[int]        # Option so an explicit 0 survives (fixture: loginCount.min = 0)
    pattern*: Option[string]
    optional*, nullable*, readonly*, writeonly*, filterable*: bool   # emitted only when true
    item*: seq[FieldSpec]          # 0 or 1 element (Option[FieldSpec] is not allowed on a recursive object)
    `ref`*: Option[string]
    fields*: seq[FieldSpec]        # ftObj members

  ActionSpec* = object
    name*: string
    description*: Option[string]
    stateField*, `from`*, to*: Option[string]
    input*: seq[FieldSpec]         # emitted only when non-empty
    transactional*: Option[bool]   # emitted only when some(false)

  SecurityScheme* = object
    name*: string
    `type`*: string                # http | apiKey
    scheme*: Option[string]        # bearer | basic
    bearerFormat*: Option[string]
    `in`*: Option[string]          # header | query | cookie
    paramName*: Option[string]

  ScopeEntry* = tuple[key: string, scopes: seq[string]]

  SecuritySpec* = object
    schemes*: seq[SecurityScheme]
    ops*: seq[ScopeEntry]          # emitted only when non-empty
    actions*: seq[ScopeEntry]      # emitted only when non-empty

  EntitySpec* = object
    specVersion*: string           # always "1.2.0"
    entity*, path*: string
    transports*: seq[string]       # rest | rpc | sse | ws
    ops*: seq[string]              # list | get | create | update | delete
    pagination*: string            # offset | cursor
    description*: Option[string]
    tags*: Option[seq[string]]     # some(@[]) emits "tags":[] like Node
    security*: Option[SecuritySpec]
    fields*: seq[FieldSpec]
    actions*: seq[ActionSpec]      # emitted only when non-empty

const SpecVersion* = "1.2.0"

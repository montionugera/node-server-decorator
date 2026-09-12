---
title: "I-006 research — Go lane prototype findings"
id: I-006
written: 2026-09-13
---

# Research — Go lane prototype

Everything here was **run**, not reasoned about. Toolchain: `go1.22.4 darwin/amd64`.

## What was proven

| Claim | Evidence |
|---|---|
| A Go builder API can emit the EntitySpec IR byte-identically | `cmp` clean vs `contracts/fixtures/entity-spec.valid-user.json`, 1461 bytes both sides |
| The `go generate` drift gate has teeth | Tampered the generated artifact → `TestGeneratedFileIsCurrent` failed with "is stale — run go generate ./..."; restored → pass |
| A root module with packages under a directory named `go/` resolves | Built and ran `module github.com/montionugera/node-server-decorator/v2` importing `.../v2/go/entity`; `go vet` clean |

## The four byte-parity constraints

Each was found by hitting the failure, not by reading docs.

1. **Declaration order is key order.** `encoding/json` emits struct fields in declaration
   order; the IR requires sorted keys. So `spec.go` declares fields alphabetically by JSON
   name. Verified alphabetical for every struct, including the non-obvious neighbours:
   `fields` < `filterable` < `format`, and `readonly` < `ref` < `role`.
   Maps are already sorted by Go (since 1.12), so `security.ops` / `security.actions`
   needed nothing.
2. **`min`/`max` must be `*int`.** The fixture has `"min":0` on `loginCount` and `score`.
   `int` + `omitempty` drops zero, silently deleting both keys.
3. **`SetEscapeHTML(false)` is required.** Go's default escapes `<`, `>`, `&` to
   `\u003c`, `\u003e`, `\u0026`; JS `JSON.stringify` and Python `json.dumps` do not.
   **The `valid-user` fixture contains none of those characters, so it cannot catch this** —
   it needs its own test.
4. **Go forbids a method and field with the same name.** First attempt used fluent setters
   (`.Min(2).Optional()`) and failed to compile with
   `field and method with the same name Min`. Resolution: package-level `FieldOpt` option
   values, which sit in a different namespace and read more like the decorator markers.

## The declaration surface that produced the matching bytes

```go
var UserSpec = e.New("User", "users").
	Desc("A registered user account").
	Tags("identity").
	Transports("rest", "rpc", "sse", "ws").
	Ops("list", "get", "create", "update", "delete").
	Pagination("offset").
	Fields(
		e.Str("id", e.ID, e.Readonly),
		e.Str("email", e.Desc("Primary contact address"), e.Format("email"), e.Filterable),
		e.Str("name", e.Min(2), e.Max(80)),
		e.Enum("status", e.Values("inactive", "active", "banned"), e.Filterable),
		e.Int("loginCount", e.Min(0), e.Readonly),
		e.List("tags", e.Of(e.Str("tags"))),
		e.Obj("profile", e.Sub(e.Str("bio", e.Max(500), e.Optional)), e.Optional),
		e.DateTime("birthday", e.Nullable, e.Optional),
		e.Float("score", e.Min(0), e.Optional),
		e.Bool("active", e.Optional),
		e.Str("secretNote", e.Max(100), e.Writeonly, e.Optional),
	).
	Actions(
		e.Act("activate").
			Desc("Move a dormant account back to active").
			Transition("status", "inactive", "active").
			In(e.Str("reason", e.Max(200), e.Optional)),
		e.Act("ping"),
	).
	Secure(e.Security{
		Schemes: []e.Scheme{{Name: "bearerAuth", Type: "http", Scheme: "bearer", BearerFormat: "JWT"}},
		Ops:     map[string][]string{"create": {"user:write"}, "update": {"user:write"}, "delete": {"user:admin"}},
		Actions: map[string][]string{"activate": {"user:admin"}},
	}).
	Build()
```

## The canonical marshaller

```go
func MarshalCanonical(s Spec) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
```

`Encoder.Encode` appends a newline that `json.Marshal` does not; the `TrimRight` is what
makes it byte-equal to the fixture.

## Rejected alternatives (with the reason, so they are not re-litigated)

- **Marker comments + AST** (`// +restful:path=/users`, `golang.org/x/tools/go/packages`,
  optionally `sigs.k8s.io/controller-tools/pkg/markers`): keeps the declaration on the type
  and mirrors the decorators most closely, but markers are unchecked strings — typos fail at
  generate time, not compile time — and it costs a marker registry plus an AST traversal for
  no additional IR expressiveness. Its exact API surface was **not** verified.
- **Struct tags + reflection**: field-level only, so entity-level and action-level metadata
  have nowhere to live, and nested `obj` / `list` fields have no tag representation.

## Not investigated

- `gen-openapi` in Go — no prototype; assumed to be the same canonical-JSON problem at
  larger scale, which is why it was split out of this release's scope.
- Whether `sigs.k8s.io/controller-tools/pkg/markers` is still the current marker-parsing
  package, or its API shape.
- Go module resolution behaviour against a **private** repo was reasoned about from the
  documented `GOPRIVATE` mechanism, **not** tested end-to-end with a real `go get`.

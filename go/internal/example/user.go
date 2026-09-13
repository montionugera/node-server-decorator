// Package example declares the User entity mirroring
// contracts/fixtures/entity-spec.valid-user.json. It exists only to feed the parity tests.
package example

import e "github.com/montionugera/node-server-decorator/v2/go/entity"

//go:generate go run ../../cmd/gen-entity-spec -out testdata

// UserSpec must marshal byte-identical to contracts/fixtures/entity-spec.valid-user.json.
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

# Go — Complete Feature Suite

The Go module provides a standard-library-only (`go.mod` has zero third-party dependencies) implementation of the full `server-decorator` ecosystem for Go 1.22+.

Module: `github.com/montionugera/node-server-decorator/v2` · Go 1.22+ · Zero external dependencies.

---

## Package Overview

| Package | Path | Capabilities |
| :--- | :--- | :--- |
| **`entity`** | `go/entity` | EntitySpec IR declaration, AST & struct-tag parser (`entity:"..."`), canonical JSON encoder |
| **`openapi`** | `go/openapi` | OpenAPI 3.1 document generator with 100% byte-identical parity to contract fixtures |
| **`dto`** | `go/dto` | Runtime DTO validation engine (`create`, `update`, `read`, `action`) & Go struct code generator |
| **`core`** | `go/core` | Deterministic cache key algorithm, generic `Cache[In, Out]` wrapper, and `EmitOnSuccess[In, Out]` |
| **`httpserver`** | `go/http` | REST route mounting on standard Go 1.22+ `http.ServeMux` and RFC 9457 Problem Details |

---

## 1. Declaring Entities (`go/entity`)

### Fluent Builder API
```go
package main

import (
	e "github.com/montionugera/node-server-decorator/v2/go/entity"
)

var UserSpec = e.New("User", "users").
	Desc("A registered user account").
	Tags("identity").
	Transports("rest", "rpc").
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
			Desc("Move account back to active").
			Transition("status", "inactive", "active").
			In(e.Str("reason", e.Max(200), e.Optional)),
	).
	Build()
```

### AST Struct-Tag Parser (`go/entity`)
You can also declare domain structs with `entity:"..."` tags and parse them automatically:

```go
type User struct {
	ID         string     `entity:"id,readonly,role=id"`
	Email      string     `entity:"email,format=email,filterable,desc='Primary contact address'"`
	Name       string     `entity:"name,min=2,max=80"`
	Status     string     `entity:"status,enum=inactive|active|banned,filterable"`
	LoginCount int        `entity:"loginCount,min=0,readonly"`
	Tags       []string   `entity:"tags"`
	Profile    *Profile   `entity:"profile,optional"`
	Birthday   *time.Time `entity:"birthday,nullable,optional"`
	Score      *float64   `entity:"score,min=0,optional"`
	Active     *bool      `entity:"active,optional"`
	SecretNote string     `entity:"secretNote,max=100,writeonly,optional"`
}

spec, err := entity.ParseStruct(src, "User")
```

---

## 2. Generating OpenAPI 3.1 Documents (`go/openapi`)

Generate complete, compliant OpenAPI 3.1 specifications matching Node, Python, and Nim byte-for-byte:

```go
import "github.com/montionugera/node-server-decorator/v2/go/openapi"

docBytes, err := openapi.Generate([]entity.Spec{UserSpec}, "1.2.0")
if err != nil {
	log.Fatal(err)
}
fmt.Println(string(docBytes))
```

---

## 3. DTO Validation & Code Generation (`go/dto`)

Validate payloads according to `contracts/fixtures/entity-spec.cases.json`:

```go
import "github.com/montionugera/node-server-decorator/v2/go/dto"

// Validate incoming JSON payload against DTO projection ("create", "update", "read", "action:<name>")
errorFields, ok := dto.Validate(UserSpec, "create", requestPayload)
if !ok {
	// Returns sorted list of invalid fields: ["email", "name"]
	fmt.Printf("Validation failed on: %v\n", errorFields)
}
```

Generate Go DTO struct code via CLI:
```bash
go run ./go/cmd/gen-dto -out internal/dtos
```

---

## 4. Core Caching & Queue Emission (`go/core`)

### Generic `Cache[In, Out]` & Deterministic Cache Keys
```go
import (
	"time"
	"github.com/montionugera/node-server-decorator/v2/go/core"
)

cacheAdapter := core.NewInMemoryCacheAdapter()

// Wrap any func(context.Context, In) (Out, error)
cachedGetUser := core.Cache[string, *User](
	cacheAdapter,
	"UserService.Get",
	5*time.Minute,
	func(ctx context.Context, id string) (*User, error) {
		return db.FindUser(ctx, id)
	},
)

user, err := cachedGetUser(ctx, "user-123")
```

### Generic `EmitOnSuccess[In, Out]`
```go
queueAdapter := core.NewInMemoryQueueAdapter()

emitOrder := core.EmitOnSuccess[OrderInput, *Order](
	queueAdapter,
	"orders.created",
	func(ctx context.Context, in OrderInput) (*Order, error) {
		return db.CreateOrder(ctx, in)
	},
)

// Emits standardized QueueMessage envelope on success
order, err := emitOrder(ctx, input)
```

---

## 5. HTTP Router Adapter (`go/http`)

Mount REST routes directly on Go 1.22+ `http.ServeMux` with built-in RFC 9457 Problem Details:

```go
import (
	"net/http"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

mux := http.NewServeMux()
handler := &MyUserHandler{}

httpserver.MountRoutes(mux, UserSpec, handler)
http.ListenAndServe(":8080", mux)
```
Automatically mounts:
- `GET /users` (with limit/offset pagination and filterable params)
- `POST /users` (validates `create` DTO, returns 201 or 400 ValidationProblem)
- `GET /users/{id}` (returns 200 or 404 Problem)
- `PATCH /users/{id}` (validates `update` DTO, returns 200 or 400/404)
- `DELETE /users/{id}` (returns 204 No Content or 404)
- `POST /users/{id}/actions/activate` (validates action input DTO)

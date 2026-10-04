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
| **`core`** | `go/core` | Deterministic cache key algorithm, generic `Cache[In, Out]`, `EmitOnSuccess[In, Out]`, `Retry`, `CircuitBreakerWrapper` and `RateLimit` wrappers |
| **`coalesce`** | `go/core/coalesce` | Batch `Loader` and `MultiTierLoader` (L1 LRU, L2 `MGetCache`, L3 batch function) |
| **`distlock`** | `go/core/distlock` | Redis distributed lock with a heartbeat watchdog (`Locker.Acquire`, `Locker.Do`) |
| **`tracing`** | `go/core/tracing` | W3C `traceparent` parsing/formatting, `StartSpan`, generic `Trace[In, Out]` |
| **`httpserver`** | `go/http` | REST route mounting on standard Go 1.22+ `http.ServeMux`, RFC 9457 Problem Details, scope auth |
| **`sse`** | `go/sse` | Generic `Broadcaster[T]` with history and `Last-Event-ID` replay |
| **`gqlloader`** | `go/adapter/gqlloader` | Request-scoped GraphQL loader registry over `coalesce` |
| **`gin`** | `go/adapter/gin` | Gin router adapter. A **separate module** with its own `go.mod`; the root module stays dependency-free |

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
	"context"
	"log"
	"sync"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

// go/core ships no built-in adapter: implement the two-method core.CacheAdapter
// interface over your store. Report an absent key with core.ErrCacheMiss (or the
// core.CacheMiss value) so a cached nil / zero value still counts as a hit.
type mapCache struct {
	mu sync.Mutex
	m  map[string]any
}

func (c *mapCache) Get(_ context.Context, key string) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[key]
	if !ok {
		return nil, core.ErrCacheMiss
	}
	return v, nil
}

func (c *mapCache) Set(_ context.Context, key string, val any, _ time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = val
	return nil
}

cacheAdapter := &mapCache{m: map[string]any{}}

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

A failing `Set` fails open (the result is still returned); a failing `Get` fails closed (the error is returned and the wrapped function is not called). A NaN or infinite float argument returns an error wrapping `core.ErrNonFiniteCacheArg`.

### Generic `EmitOnSuccess[In, Out]`
```go
// Likewise, implement core.QueueAdapter over your broker client.
type logQueue struct{}

func (logQueue) Publish(_ context.Context, msg core.QueueMessage) error {
	log.Printf("publish %s at %d", msg.EventName, msg.Timestamp)
	return nil
}

queueAdapter := logQueue{}

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

A transform passed with `core.WithEmitTransform` that panics is recovered and nothing is published; the caller still gets the wrapped function's result.

### Distributed lock (`go/core/distlock`)
```go
import "github.com/montionugera/node-server-decorator/v2/go/core/distlock"

// redisClient implements the two-method distlock.RedisClient interface (SetNX, Eval).
locker := distlock.New(distlock.Config{Client: redisClient, DefaultTTL: 30 * time.Second})

err := locker.Do(ctx, "invoice:42", func(ctx context.Context) error {
	// ctx is cancelled with cause distlock.ErrLockLost if the lease is lost.
	return chargeInvoice(ctx)
})
```

- The heartbeat watchdog renews the lease **by default**, as in Node and Python. Turn it off with `Config.DisableAutoRenew` or per acquire with `distlock.WithAutoRenew(false)`. `Config.AutoRenew` is deprecated and ignored: an explicit `AutoRenew: false` no longer disables renewal.
- A renewal that errors is retried on the next tick; the lease is declared lost only on a definite refusal or once a full TTL passes with no confirmed renewal.
- `Lock.Lost()` is closed when the lease is lost, and `Release` / `Do` then return `distlock.ErrLockLost`.
- `Release` is retryable: if the release script could not run, the call returns a wrapped error and a later call retries. `Do` returns the release error, joined with `fn`'s error when both fail.

### Tracing (`go/core/tracing`)

`tracing.ParseTraceparent` accepts only version `00`, lower-case hex and non-zero trace/span ids, the same verdicts as Node and Python (`contracts/fixtures/trace-context.cases.json`). A panic inside a function wrapped with `tracing.Trace` exports the span as `ERROR` and then re-panics with the original value.

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

If the spec declares a `security` requirement, mount with `httpserver.WithAuth(extractor)`. Without an extractor a secured operation answers `401` (fail closed) rather than running unauthenticated.

---

## Testing & Coverage Gate

Run from the repository root:

```bash
go test ./go/...                      # unit tests, stdlib only
bash scripts/check-go-coverage.sh     # same tests + per-package statement-coverage gate (what CI runs)
```

The thresholds live at the top of `scripts/check-go-coverage.sh` and are a ratchet: raise them as tests are added, never lower one. A package that appears in the coverprofile without an entry fails the gate, so a new package must declare a threshold. `go/adapter/gin` is a separate module and is tested on its own (`cd go/adapter/gin && go test ./...`).

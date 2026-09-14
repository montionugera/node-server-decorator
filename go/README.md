# Go — `entity` (EntitySpec IR producer)

Declare an entity in typed Go and emit the EntitySpec IR — byte-identical to the Node
(`@montionugera/entity-spec`) and Python (`server-decorator-entity`) packages, validated against
`contracts/schemas/entity-spec.schema.json` (conformance is proven by byte parity with the contract fixture). This release ships the IR producer only: no OpenAPI
generator, DTO validators, or HTTP adapters in Go yet.

Module: `github.com/montionugera/node-server-decorator/v2` · package: `.../v2/go/entity` ·
Go 1.22+ · standard library only. Versions move in lockstep with the Node and Python packages.

## Install (private repository)

```bash
go env -w GOPRIVATE=github.com/montionugera/*
git config --global url."git@github.com:".insteadOf "https://github.com/"
go get github.com/montionugera/node-server-decorator/v2@latest
```

While the repository is private, `proxy.golang.org` and `pkg.go.dev` do not serve this module:
there is no rendered API documentation and no module-proxy caching. Versions resolve only from
`vX.Y.Z` git tags; the first Go-resolvable version is the first tag pushed after `go.mod` landed
(`v2.0.0` predates it and does not resolve).

## Declare an entity

```go
import e "github.com/montionugera/node-server-decorator/v2/go/entity"

var UserSpec = e.New("User", "users").
	Transports("rest", "rpc").
	Fields(
		e.Str("id", e.ID, e.Readonly),
		e.Str("email", e.Format("email"), e.Filterable),
		e.Enum("status", e.Values("inactive", "active")),
		e.Int("loginCount", e.Min(0), e.Readonly),
	).
	Actions(e.Act("activate").Transition("status", "inactive", "active")).
	Build()
```

`New` defaults match `@Restful` / `@restful`: transports `rest`, all five ops, `offset` pagination.

## Generate the IR with `go generate`

A prebuilt command cannot import your specs, so add a small generator to your repo:

```go
// internal/genspec/main.go
package main

import (
	"flag"
	"log"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"example.com/you/internal/entities"
)

func main() {
	out := flag.String("out", ".", "output directory")
	flag.Parse()
	if err := e.WriteFiles(*out, entities.UserSpec); err != nil {
		log.Fatal(err)
	}
}
```

Next to your specs: `//go:generate go run ../genspec -out ../../spec`. Run `go generate ./...` and
commit the `entity-spec.<path>.json` files. Add a test comparing each committed file with
`e.MarshalCanonical(spec)` so a stale artifact fails CI —
see `go/internal/example/user_test.go` (`TestGeneratedFileIsCurrent`) in this repo.

## Byte-format rules (for contributors)

`go/entity/spec.go` is the only code that knows the byte format. Keep struct fields declared in
sorted JSON-name order, keep `Min`/`Max` as `*int`, and keep `SetEscapeHTML(false)` — each is
guarded by a test in `go/entity/spec_test.go`.

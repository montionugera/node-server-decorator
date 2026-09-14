// Command emitfixture prints the User IR to stdout for scripts/check-entity-parity.sh — the Go
// twin of node/packages/entity/scripts/emit-fixture.ts and
// python/packages/entity/scripts/emit_fixture.py.
package main

import (
	"log"
	"os"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func main() {
	b, err := e.MarshalCanonical(example.UserSpec)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stdout.Write(b); err != nil {
		log.Fatal(err)
	}
}

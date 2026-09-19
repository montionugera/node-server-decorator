// Command emitopenapi prints the User OpenAPI 3.1 document to stdout for scripts/check-openapi-parity.sh.
package main

import (
	"log"
	"os"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
	"github.com/montionugera/node-server-decorator/v2/go/openapi"
)

func main() {
	b, err := openapi.Generate([]entity.Spec{example.UserSpec}, "1.2.0")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stdout.Write(b); err != nil {
		log.Fatal(err)
	}
}

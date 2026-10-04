// Command emitopenapi prints the User OpenAPI 3.1 document to stdout for scripts/check-openapi-parity.sh.
package main

import (
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
	"github.com/montionugera/node-server-decorator/v2/go/openapi"
)

// contractVersion reads contracts/VERSION, the document's info.version in every
// lane (the Node, Python and Nim emitters read the same file). It is located
// from this source file, not the working directory, so `go run` from the repo
// root and `go test` from the package directory resolve the same path.
func contractVersion() (string, error) {
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "contracts", "VERSION"))
	return strings.TrimSpace(string(b)), err
}

func main() {
	version, err := contractVersion()
	if err != nil {
		log.Fatal(err)
	}
	b, err := openapi.Generate([]entity.Spec{example.UserSpec}, version)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stdout.Write(b); err != nil {
		log.Fatal(err)
	}
}

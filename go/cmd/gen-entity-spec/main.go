// Command gen-entity-spec writes this repo's example entity specs as IR JSON. It is the
// reference go:generate target: a consumer copies it, swapping in their own specs.
package main

import (
	"flag"
	"log"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func main() {
	out := flag.String("out", ".", "directory to write entity-spec.<path>.json files into")
	flag.Parse()
	if err := e.WriteFiles(*out, example.UserSpec); err != nil {
		log.Fatal(err)
	}
}

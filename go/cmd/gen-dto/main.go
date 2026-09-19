// Command gen-dto generates typed Go struct DTOs from an EntitySpec.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func main() {
	out := flag.String("out", "", "output file path or directory (default stdout)")
	pkg := flag.String("pkg", "dto", "package name for generated structs")
	flag.Parse()

	code, err := dto.GenerateGoStructs(example.UserSpec, *pkg)
	if err != nil {
		log.Fatalf("failed to generate DTO structs: %v", err)
	}

	if *out == "" {
		fmt.Print(string(code))
		return
	}

	targetPath := *out
	info, err := os.Stat(targetPath)
	if err == nil && info.IsDir() {
		targetPath = filepath.Join(targetPath, "user_dto.go")
	}

	if err := os.WriteFile(targetPath, code, 0o644); err != nil {
		log.Fatalf("failed to write output: %v", err)
	}
}

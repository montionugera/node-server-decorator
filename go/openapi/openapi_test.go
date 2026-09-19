package openapi

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func TestOpenAPIGenerateMatchesContractFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "contracts", "fixtures", "openapi.valid-user.json")
	want, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("failed to read fixture: %v", err)
	}

	got, err := Generate([]entity.Spec{example.UserSpec}, "1.2.0")
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	if !bytes.Equal(got, want) {
		t.Fatalf("OpenAPI output != contract fixture\n got: %s\nwant: %s", string(got), string(want))
	}
}

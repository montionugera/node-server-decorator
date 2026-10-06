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

	// The fixture's info.version is the contract version, as in the other lanes' emitters.
	rawVersion, err := os.ReadFile(filepath.Join("..", "..", "contracts", "VERSION"))
	if err != nil {
		t.Fatalf("failed to read contracts/VERSION: %v", err)
	}

	got, err := Generate([]entity.Spec{example.UserSpec}, string(bytes.TrimSpace(rawVersion)))
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	if !bytes.Equal(got, want) {
		t.Fatalf("OpenAPI output != contract fixture\n got: %s\nwant: %s", string(got), string(want))
	}
}

package example

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"testing"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
)

// Drift guard for this hand copy of the root module's go/internal/example.UserSpec.
func TestUserSpecMatchesContractFixture(t *testing.T) {
	want, err := os.ReadFile("../../../../../contracts/fixtures/entity-spec.valid-user.json")
	if errors.Is(err, fs.ErrNotExist) {
		// The fixture lives outside this module: absent when it is consumed from the module cache.
		t.Skip("contracts fixture not present (module consumed outside the repo)")
	}
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.MarshalCanonical(UserSpec)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Go IR != contract fixture\n got: %s\nwant: %s", got, want)
	}
}

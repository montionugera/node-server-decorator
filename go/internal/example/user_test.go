package example

import (
	"bytes"
	"os"
	"testing"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
)

func TestUserSpecMatchesContractFixture(t *testing.T) {
	want, err := os.ReadFile("../../../contracts/fixtures/entity-spec.valid-user.json")
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

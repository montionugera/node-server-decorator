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

func TestGeneratedFileIsCurrent(t *testing.T) {
	path := "testdata/" + e.FileName(UserSpec)
	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s missing — run go generate ./go/...: %v", path, err)
	}
	// Regenerate through the same WriteFiles path go:generate uses, so a generator bug is caught too.
	dir := t.TempDir()
	if err := e.WriteFiles(dir, UserSpec); err != nil {
		t.Fatal(err)
	}
	fresh, err := os.ReadFile(dir + "/" + e.FileName(UserSpec))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(committed, fresh) {
		t.Fatalf("%s is stale — run go generate ./go/...", path)
	}
}

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// main prints the canonical User IR to stdout; scripts/check-entity-parity.sh compares that
// output with the contract fixture, so the test does the same in-process.
func TestMainCoverage_PrintsContractFixtureToStdout(t *testing.T) {
	outPath := filepath.Join(t.TempDir(), "stdout")
	out, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}

	orig := os.Stdout
	os.Stdout = out
	func() {
		defer func() { os.Stdout = orig }()
		main()
	}()
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "fixtures", "entity-spec.valid-user.json"))
	if err != nil {
		t.Fatalf("reading contract fixture: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("emitfixture output != contract fixture\n got: %s\nwant: %s", got, want)
	}
}

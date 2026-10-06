package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"testing"
)

func covCaptureMain(t *testing.T) []byte {
	t.Helper()
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	captured := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(r)
		captured <- b
	}()

	main()

	w.Close()
	os.Stdout = oldStdout
	return <-captured
}

// The parity script diffs this command's stdout against the shared fixture, so main must
// print exactly the fixture document and nothing else.
func TestMain_EmitsTheSharedOpenAPIFixture(t *testing.T) {
	got := covCaptureMain(t)

	want, err := os.ReadFile("../../../../contracts/fixtures/openapi.valid-user.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if !bytes.Equal(bytes.TrimRight(got, "\n"), bytes.TrimRight(want, "\n")) {
		t.Fatalf("stdout is not byte-identical to contracts/fixtures/openapi.valid-user.json:\n%s", got)
	}

	var doc struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Version string `json:"version"`
		} `json:"info"`
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(got, &doc); err != nil {
		t.Fatalf("stdout is not a single JSON document: %v", err)
	}
	// info.version is the contract version, read independently of main's own lookup.
	rawVersion, err := os.ReadFile("../../../../contracts/VERSION")
	if err != nil {
		t.Fatalf("read contracts/VERSION: %v", err)
	}
	wantVersion := string(bytes.TrimSpace(rawVersion))
	if doc.OpenAPI == "" || wantVersion == "" || doc.Info.Version != wantVersion {
		t.Fatalf("openapi=%q info.version=%q, want a 3.x document at contract version %q", doc.OpenAPI, doc.Info.Version, wantVersion)
	}
	if _, ok := doc.Paths["/users"]; !ok {
		t.Fatalf("document has no /users path: %v", doc.Paths)
	}
}

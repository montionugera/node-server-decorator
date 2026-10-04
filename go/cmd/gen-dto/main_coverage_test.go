package main

import (
	"bytes"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

// covRunMain runs main() with the given CLI arguments and returns what it printed to stdout.
func covRunMain(t *testing.T, args ...string) []byte {
	t.Helper()

	oldArgs, oldFlags, oldStdout := os.Args, flag.CommandLine, os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Args = append([]string{"gen-dto"}, args...)
	flag.CommandLine = flag.NewFlagSet("gen-dto", flag.PanicOnError)
	os.Stdout = w
	defer func() { os.Args, flag.CommandLine, os.Stdout = oldArgs, oldFlags, oldStdout }()

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

func covWantCode(t *testing.T, pkg string) []byte {
	t.Helper()
	want, err := dto.GenerateGoStructs(example.UserSpec, pkg)
	if err != nil {
		t.Fatalf("GenerateGoStructs: %v", err)
	}
	if !bytes.Contains(want, []byte("package "+pkg)) {
		t.Fatalf("generated code does not declare package %s", pkg)
	}
	return want
}

func TestMain_PrintsToStdoutByDefault(t *testing.T) {
	got := covRunMain(t)
	if want := covWantCode(t, "dto"); !bytes.Equal(got, want) {
		t.Fatalf("stdout differs from the generated code for the default package dto:\n%s", got)
	}
}

func TestMain_PkgFlagWritesToFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "custom.go")
	if stdout := covRunMain(t, "-pkg", "models", "-out", target); len(stdout) != 0 {
		t.Fatalf("nothing must be printed when -out is set, got %q", stdout)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("output file not written: %v", err)
	}
	if want := covWantCode(t, "models"); !bytes.Equal(got, want) {
		t.Fatalf("file content differs from the generated code for package models:\n%s", got)
	}
}

func TestMain_OutDirectoryGetsDefaultFileName(t *testing.T) {
	dir := t.TempDir()
	if stdout := covRunMain(t, "-out", dir); len(stdout) != 0 {
		t.Fatalf("nothing must be printed when -out is set, got %q", stdout)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "user_dto.go" {
		t.Fatalf("directory entries = %v, want exactly user_dto.go", entries)
	}
	got, err := os.ReadFile(filepath.Join(dir, "user_dto.go"))
	if err != nil {
		t.Fatal(err)
	}
	if want := covWantCode(t, "dto"); !bytes.Equal(got, want) {
		t.Fatal("user_dto.go differs from the generated code")
	}
}

func TestMain_OverwritesExistingFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "stale.go")
	if err := os.WriteFile(target, bytes.Repeat([]byte("stale content\n"), 2000), 0o644); err != nil {
		t.Fatal(err)
	}
	covRunMain(t, "-out", target)
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if want := covWantCode(t, "dto"); !bytes.Equal(got, want) {
		t.Fatal("an existing file must be fully replaced, not appended to or partially overwritten")
	}
}

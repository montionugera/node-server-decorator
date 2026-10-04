package entity

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func genCovSpec(entityName, path string) Spec {
	return New(entityName, path).Fields(Str("id", ID, Readonly), Str("name", Min(1))).Build()
}

func TestGenerateCoverage_FileName(t *testing.T) {
	cases := map[string]string{
		"users":       "entity-spec.users.json",
		"order-items": "entity-spec.order-items.json",
		"":            "entity-spec..json",
	}
	for path, want := range cases {
		if got := FileName(Spec{Path: path}); got != want {
			t.Errorf("FileName(path=%q) = %q, want %q", path, got, want)
		}
	}
}

func TestGenerateCoverage_WriteFilesWritesCanonicalIRPerSpec(t *testing.T) {
	dir := t.TempDir()
	users, orders := genCovSpec("User", "users"), genCovSpec("Order", "orders")

	if err := WriteFiles(dir, users, orders); err != nil {
		t.Fatalf("WriteFiles: %v", err)
	}

	for _, s := range []Spec{users, orders} {
		want, err := MarshalCanonical(s)
		if err != nil {
			t.Fatalf("MarshalCanonical: %v", err)
		}
		got, err := os.ReadFile(filepath.Join(dir, FileName(s)))
		if err != nil {
			t.Fatalf("reading %s: %v", FileName(s), err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s:\n got %s\nwant %s", FileName(s), got, want)
		}
		if bytes.HasSuffix(got, []byte("\n")) {
			t.Errorf("%s must not end with a newline (canonical IR has none)", FileName(s))
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Errorf("expected exactly 2 files, got %d", len(entries))
	}
}

func TestGenerateCoverage_WriteFilesOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	s := genCovSpec("User", "users")
	target := filepath.Join(dir, FileName(s))
	if err := os.WriteFile(target, []byte("stale content that is longer than the canonical IR will ever be ................................................................................................................................................................................................"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := WriteFiles(dir, s); err != nil {
		t.Fatalf("WriteFiles: %v", err)
	}
	want, _ := MarshalCanonical(s)
	got, _ := os.ReadFile(target)
	if !bytes.Equal(got, want) {
		t.Errorf("stale file was not fully replaced:\n got %s\nwant %s", got, want)
	}
}

func TestGenerateCoverage_WriteFilesWithNoSpecsWritesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := WriteFiles(dir); err != nil {
		t.Fatalf("WriteFiles with no specs: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected an empty dir, got %d entries", len(entries))
	}
}

func TestGenerateCoverage_WriteFilesReturnsErrorForMissingDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	err := WriteFiles(missing, genCovSpec("User", "users"))
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected os.ErrNotExist, got %v", err)
	}
}

func TestGenerateCoverage_WriteFilesStopsAtFirstFailure(t *testing.T) {
	dir := t.TempDir()
	first := genCovSpec("User", "users")
	// The path lands in a sub-directory that does not exist, so this write fails.
	broken := genCovSpec("Order", "missing/orders")
	never := genCovSpec("Item", "items")

	err := WriteFiles(dir, first, broken, never)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected os.ErrNotExist, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, FileName(first))); statErr != nil {
		t.Errorf("spec before the failure should have been written: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(dir, FileName(never))); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("spec after the failure must not be written, stat err = %v", statErr)
	}
}

package entity

import (
	"os"
	"path/filepath"
)

// FileName is the artifact name for s: entity-spec.<path>.json.
func FileName(s Spec) string { return "entity-spec." + s.Path + ".json" }

// WriteFiles writes each spec's canonical IR to dir/FileName(spec). A consumer's go:generate
// target is a small main that calls this with its declared specs (see go/cmd/gen-entity-spec).
func WriteFiles(dir string, specs ...Spec) error {
	for _, s := range specs {
		b, err := MarshalCanonical(s)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, FileName(s)), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

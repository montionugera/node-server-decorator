package core_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

type cacheKeyExample struct {
	Name           string         `json:"name"`
	Qualname       string         `json:"qualname"`
	Args           []any          `json:"args"`
	Kwargs         map[string]any `json:"kwargs"`
	Expected       string         `json:"expected"`
	ExpectedPrefix string         `json:"expected_prefix"`
}

type cacheKeyFixture struct {
	Examples []cacheKeyExample `json:"examples"`
}

func loadFixture(t *testing.T) cacheKeyFixture {
	t.Helper()
	candidates := []string{
		"../../contracts/fixtures/cache-key.examples.json",
		"contracts/fixtures/cache-key.examples.json",
		"../../../contracts/fixtures/cache-key.examples.json",
	}

	var data []byte
	var readErr error
	for _, path := range candidates {
		abs, err := filepath.Abs(path)
		if err == nil {
			data, readErr = os.ReadFile(abs)
			if readErr == nil {
				break
			}
		}
	}
	if data == nil {
		t.Fatalf("could not load cache-key.examples.json: %v", readErr)
	}

	var fixture cacheKeyFixture
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&fixture); err != nil {
		t.Fatalf("failed to decode fixture JSON: %v", err)
	}
	return fixture
}

func TestBuildCacheKey_GoldenFixtures(t *testing.T) {
	fixture := loadFixture(t)
	if len(fixture.Examples) == 0 {
		t.Fatal("no examples loaded from fixture")
	}

	for _, tc := range fixture.Examples {
		t.Run(tc.Name, func(t *testing.T) {
			actual := core.BuildCacheKey(tc.Qualname, tc.Args, tc.Kwargs)

			if tc.ExpectedPrefix != "" {
				if !strings.HasPrefix(actual, tc.ExpectedPrefix) {
					t.Errorf("expected key to start with %q, got %q", tc.ExpectedPrefix, actual)
				}
				if !strings.HasSuffix(actual, ")") {
					t.Errorf("expected hashed key to end with ')', got %q", actual)
				}
				// Verify raw would have been > 250 bytes
				// By formatting with large payload, actual key length with sha256 is bounded.
				if len(actual) > core.MaxKeyBytes {
					t.Errorf("hashed key length (%d) exceeds MaxKeyBytes (%d)", len(actual), core.MaxKeyBytes)
				}
			} else {
				if actual != tc.Expected {
					t.Errorf("mismatch for %q:\nwant: %s\ngot:  %s", tc.Name, tc.Expected, actual)
				}
			}
		})
	}
}

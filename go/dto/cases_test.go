package dto

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

type contractCase struct {
	Name        string          `json:"name"`
	DTO         string          `json:"dto"`
	Payload     json.RawMessage `json:"payload"`
	Valid       bool            `json:"valid"`
	ErrorFields []string        `json:"errorFields"`
}

type fixtureData struct {
	Entity string         `json:"entity"`
	Cases  []contractCase `json:"cases"`
}

func TestCasesMatchesContractFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "contracts", "fixtures", "entity-spec.cases.json")
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", fixturePath, err)
	}

	var fixture fixtureData
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("failed to unmarshal fixture: %v", err)
	}

	if len(fixture.Cases) != 22 {
		t.Fatalf("expected 22 test cases, got %d", len(fixture.Cases))
	}

	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			// Use json.Decoder with UseNumber to preserve numbers accurately
			decoder := json.NewDecoder(bytes.NewReader(c.Payload))
			decoder.UseNumber()

			var payload any
			if err := decoder.Decode(&payload); err != nil {
				t.Fatalf("failed to decode payload: %v", err)
			}

			errFields, ok := Validate(example.UserSpec, c.DTO, payload)

			if ok != c.Valid {
				t.Errorf("expected valid=%v, got %v (errFields=%v)", c.Valid, ok, errFields)
			}

			wantErrFields := c.ErrorFields
			if wantErrFields == nil {
				wantErrFields = []string{}
			}

			if !ok {
				if !reflect.DeepEqual(errFields, wantErrFields) {
					t.Errorf("errorFields mismatch: got %v, want %v", errFields, wantErrFields)
				}
			}
		})
	}
}

package dto

import (
	"reflect"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

// str min/max count Unicode code points, not bytes
// (contracts/rules/rest-conventions.md, "String length").
func TestValidateStringLengthCountsCodePoints(t *testing.T) {
	minLen, maxLen := 3, 5
	spec := entity.Spec{
		Fields: []entity.Field{
			{Name: "name", Type: "str", Min: &minLen, Max: &maxLen},
		},
	}

	cases := []struct {
		name  string
		value string
		valid bool
	}{
		{"ascii at max", "hello", true},
		{"ascii over max", "hello!", false},
		{"latin-1 at max (6 bytes, 5 code points)", "héllo", true},
		{"thai below min (6 bytes, 2 code points)", "กข", false},
		{"thai at min (9 bytes, 3 code points)", "กขฃ", true},
		{"emoji at max (20 bytes, 5 code points)", "\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600", true},
		{"emoji over max (6 code points)", "\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600\U0001F600", false},
		{"emoji below min (2 code points, 4 UTF-16 units)", "\U0001F600\U0001F600", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fields, ok := Validate(spec, "create", map[string]any{"name": c.value})
			if ok != c.valid {
				t.Fatalf("expected valid=%v, got %v (fields=%v)", c.valid, ok, fields)
			}
			if !ok && !reflect.DeepEqual(fields, []string{"name"}) {
				t.Fatalf("expected fields [name], got %v", fields)
			}
		})
	}
}

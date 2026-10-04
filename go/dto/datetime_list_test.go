package dto

import (
	"reflect"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

// Same value lists as gen-zod's datetime-and-length.spec.ts and gen_pydantic's
// test_json_type_parity.py — see `type: "datetime"` in
// contracts/rules/entity-spec-validation.md.
func TestValidateDateTimeShape(t *testing.T) {
	spec := entity.Spec{Fields: []entity.Field{{Name: "at", Type: "datetime"}}}
	cases := map[string]bool{
		"2024-01-01 00:00:00Z":             false,
		"2024-01-01t00:00:00z":             false,
		"1704067200":                       false,
		"2024-01-01T00:00:00+0100":         false,
		"2024-01-01T00:00:00+01":           false,
		"2024-01-01T00:00:00+24:00":        false,
		"2024-01-01T00:00Z":                false,
		"2024-01-01T00:00:00,5Z":           false,
		"2024-01-01T00:00:00Z\n":           false,
		"2024-02-30T00:00:00Z":             false,
		"2024-01-01T00:00:00":              false,
		"2024-01-01T00:00:00Z":             true,
		"2024-01-01T00:00:00.123456+07:00": true,
		"2024-01-01T23:59:59-23:59":        true,
	}
	for value, valid := range cases {
		if _, ok := Validate(spec, "create", map[string]any{"at": value}); ok != valid {
			t.Errorf("%q: expected valid=%v, got %v", value, valid, ok)
		}
	}
}

// A null list element follows the item's own nullable flag, at every nesting level and for
// every item type (the null check used to live in validateObject only).
func TestValidateListNullItems(t *testing.T) {
	nullableObj := entity.Field{Name: "rows", Type: "obj", Nullable: true, Fields: []entity.Field{{Name: "a", Type: "str"}}}
	inner := entity.Field{Name: "grid", Type: "list", Item: &entity.Field{Name: "grid", Type: "int", Nullable: true}}
	spec := entity.Spec{Fields: []entity.Field{
		{Name: "rows", Type: "list", Item: &nullableObj},
		{Name: "grid", Type: "list", Item: &inner},
	}}

	payload := map[string]any{
		"rows": []any{nil, map[string]any{"a": "x"}},
		"grid": []any{[]any{nil, 1.0}},
	}
	if fields, ok := Validate(spec, "create", payload); !ok {
		t.Fatalf("expected valid, got fields %v", fields)
	}

	// The inner list itself is not nullable.
	payload["grid"] = []any{nil, []any{"x"}}
	fields, ok := Validate(spec, "create", payload)
	if want := []string{"grid.0", "grid.1.0"}; ok || !reflect.DeepEqual(fields, want) {
		t.Fatalf("expected fields %v, got %v (valid=%v)", want, fields, ok)
	}
}

package entity

import (
	"strings"
	"testing"
)

// A struct that refers back to itself (directly, through a pointer or slice, or through
// another struct) cannot be expressed as IR; ParseStruct must return an error, not recurse
// until the stack overflows (which is fatal and unrecoverable).
func TestParseStructRejectsRecursiveStruct(t *testing.T) {
	cases := map[string]string{
		"slice of self":   "type Node struct {\n ID string\n Children []Node\n}",
		"pointer to self": "type Node struct {\n ID string\n Parent *Node\n}",
		"mutual":          "type Node struct {\n Edge Edge\n}\ntype Edge struct {\n To *Node\n}",
		"inline struct":   "type Node struct {\n Meta struct {\n Owner []Node\n }\n}",
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseStruct(src, "Node")
			if err == nil || !strings.Contains(err.Error(), "recursive") {
				t.Fatalf("expected a recursive-struct error, got %v", err)
			}
		})
	}
}

// The same struct used twice side by side is not a cycle.
func TestParseStructAllowsRepeatedNonRecursiveStruct(t *testing.T) {
	src := "type Addr struct {\n City string\n}\ntype User struct {\n Home Addr\n Work Addr\n Past []Addr\n}"
	spec, err := ParseStruct(src, "User")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(spec.Fields) != 3 || spec.Fields[1].Fields[0].Name != "city" {
		t.Fatalf("unexpected fields: %+v", spec.Fields)
	}
}

// Every nested list item carries the field's wire name (Node and Python do the same), so a
// list of lists stays schema-valid.
func TestParseStructNamesEveryNestedListItem(t *testing.T) {
	spec, err := ParseStruct("type Grid struct {\n Cells [][][]string\n}", "Grid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	depth := 0
	for item := spec.Fields[0].Item; item != nil; item = item.Item {
		depth++
		if item.Name != "cells" {
			t.Fatalf("item at depth %d has name %q, want \"cells\"", depth, item.Name)
		}
	}
	if depth != 3 {
		t.Fatalf("expected 3 item levels, got %d", depth)
	}
}

// ParseStruct output must be schema-valid IR; the rules mirror
// node/packages/entity/src/validate.ts.
func TestParseStructRejectsInvalidIR(t *testing.T) {
	cases := map[string]struct{ src, want string }{
		"snake_case json tag":  {"type T struct {\n UserName string `json:\"user_name\"`\n}", "user_name"},
		"nested bad wire name": {"type T struct {\n P struct {\n A string `entity:\"Bad-Name\"`\n }\n}", "Bad-Name"},
		"reserved wire name":   {"type T struct {\n Schema string\n}", "reserved"},
		"format and pattern":   {"type T struct {\n A string `entity:\"a,format=email,pattern=^a$\"`\n}", "mutually exclusive"},
		"enum without a value": {"type T struct {\n A string `entity:\"a,type=enum\"`\n}", "enum"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseStruct(c.src, "T")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("expected an error containing %q, got %v", c.want, err)
			}
		})
	}
}

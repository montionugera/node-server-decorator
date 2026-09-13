package entity

import (
	"bytes"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestStructKeysSorted(t *testing.T) {
	for _, v := range []any{Field{}, Action{}, Scheme{}, Security{}, Spec{}} {
		typ := reflect.TypeOf(v)
		var names []string
		for i := 0; i < typ.NumField(); i++ {
			names = append(names, strings.Split(typ.Field(i).Tag.Get("json"), ",")[0])
		}
		if !sort.StringsAreSorted(names) {
			t.Errorf("%s JSON keys not declared in sorted order: %v", typ.Name(), names)
		}
	}
}

func TestMarshalCanonicalKeepsZeroMin(t *testing.T) {
	zero := 0
	s := Spec{Entity: "Z", Path: "zs", SpecVersion: SpecVersion, Pagination: "offset",
		Ops: []string{"get"}, Transports: []string{"rest"},
		Fields: []Field{{Name: "n", Type: "int", Min: &zero}}}
	got, err := MarshalCanonical(s)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(got, []byte(`{"min":0,"name":"n","type":"int"}`)) {
		t.Fatalf(`"min":0 was dropped: %s`, got)
	}
}

func TestMarshalCanonicalDoesNotEscapeHTML(t *testing.T) {
	// testdata/html-escape.json was produced by Node's JSON.stringify over sorted keys and
	// cross-checked byte-equal with Python's
	// json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).
	want, err := os.ReadFile("testdata/html-escape.json")
	if err != nil {
		t.Fatal(err)
	}
	s := Spec{Entity: "Escape", Path: "escapes", SpecVersion: SpecVersion, Pagination: "offset",
		Description: "a <b> & c \u2028 \u2029", Ops: []string{"get"}, Transports: []string{"rest"},
		Fields: []Field{{Name: "id", Type: "str", Description: `x < y && y > z \u2028`}}}
	got, err := MarshalCanonical(s)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("HTML-escape divergence\n got: %s\nwant: %s", got, want)
	}
}

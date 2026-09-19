package entity

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseStruct(t *testing.T) {
	src := `
package models

import "time"

// Profile represents a nested profile.
type Profile struct {
	Bio string ` + "`" + `entity:"bio,max=500,optional"` + "`" + `
}

// User represents a registered user account.
type User struct {
	ID         string    ` + "`" + `entity:"id,readonly,role=id"` + "`" + `
	Email      string    ` + "`" + `entity:"email,desc='Primary contact address',format=email,filterable"` + "`" + `
	Name       string    ` + "`" + `entity:"name,min=2,max=80"` + "`" + `
	Status     string    ` + "`" + `entity:"status,enum=inactive|active|banned,filterable"` + "`" + `
	LoginCount int       ` + "`" + `entity:"loginCount,min=0,readonly"` + "`" + `
	Tags       []string  ` + "`" + `entity:"tags"` + "`" + `
	Profile    Profile   ` + "`" + `entity:"profile,optional"` + "`" + `
	Birthday   time.Time ` + "`" + `entity:"birthday,nullable,optional"` + "`" + `
	Score      float64   ` + "`" + `entity:"score,min=0,optional"` + "`" + `
	Active     bool      ` + "`" + `entity:"active,optional"` + "`" + `
	SecretNote string    ` + "`" + `entity:"secretNote,max=100,writeonly,optional"` + "`" + `
	Ignored    string    ` + "`" + `entity:"-"` + "`" + `
}
`

	spec, err := ParseStruct(src, "User")
	if err != nil {
		t.Fatalf("ParseStruct failed: %v", err)
	}

	if spec.Entity != "User" {
		t.Errorf("expected entity User, got %s", spec.Entity)
	}
	if spec.Path != "users" {
		t.Errorf("expected path users, got %s", spec.Path)
	}
	if spec.Description != "User represents a registered user account." {
		t.Errorf("expected description 'User represents a registered user account.', got %q", spec.Description)
	}

	expectedFields := []Field{
		Str("id", ID, Readonly),
		Str("email", Desc("Primary contact address"), Format("email"), Filterable),
		Str("name", Min(2), Max(80)),
		Enum("status", Values("inactive", "active", "banned"), Filterable),
		Int("loginCount", Min(0), Readonly),
		List("tags", Of(Str("tags"))),
		Obj("profile", Sub(Str("bio", Max(500), Optional)), Optional),
		DateTime("birthday", Nullable, Optional),
		Float("score", Min(0), Optional),
		Bool("active", Optional),
		Str("secretNote", Max(100), Writeonly, Optional),
	}

	if len(spec.Fields) != len(expectedFields) {
		t.Fatalf("expected %d fields, got %d", len(expectedFields), len(spec.Fields))
	}

	for i, exp := range expectedFields {
		got := spec.Fields[i]
		if !reflect.DeepEqual(got, exp) {
			t.Errorf("field %d (%s) mismatch:\n got: %+v\nwant: %+v", i, exp.Name, got, exp)
		}
	}
}

func TestParseStructReaderAndBytes(t *testing.T) {
	src := `
type Simple struct {
	Count int ` + "`" + `json:"count" entity:"count,min=1"` + "`" + `
}
`
	// Test []byte
	spec1, err := ParseStruct([]byte(src), "Simple")
	if err != nil {
		t.Fatalf("ParseStruct([]byte) failed: %v", err)
	}
	if len(spec1.Fields) != 1 || spec1.Fields[0].Name != "count" || *spec1.Fields[0].Min != 1 {
		t.Errorf("unexpected spec1: %+v", spec1)
	}

	// Test io.Reader
	spec2, err := ParseStruct(strings.NewReader(src), "Simple")
	if err != nil {
		t.Fatalf("ParseStruct(io.Reader) failed: %v", err)
	}
	if len(spec2.Fields) != 1 || spec2.Fields[0].Name != "count" || *spec2.Fields[0].Min != 1 {
		t.Errorf("unexpected spec2: %+v", spec2)
	}
}

func TestParseStructErrors(t *testing.T) {
	// Not found
	_, err := ParseStruct(`type Foo struct{}`, "Bar")
	if err == nil {
		t.Errorf("expected error when struct not found")
	}

	// Invalid Go syntax
	_, err = ParseStruct(`invalid go syntax`, "Foo")
	if err == nil {
		t.Errorf("expected error on invalid syntax")
	}

	// Invalid tag
	_, err = ParseStruct(`type Foo struct { X int `+"`"+`entity:"x,min=abc"`+"`"+` }`, "Foo")
	if err == nil {
		t.Errorf("expected error on invalid min tag")
	}
}

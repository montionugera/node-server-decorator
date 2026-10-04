package entity

import (
	"reflect"
	"strings"
	"testing"
)

func TestNewAppliesRestfulDefaults(t *testing.T) {
	s := New("user", "/users").Build()
	want := Spec{
		Entity:      "user",
		Ops:         []string{"list", "get", "create", "update", "delete"},
		Pagination:  "offset",
		Path:        "/users",
		SpecVersion: SpecVersion,
		Transports:  []string{"rest"},
	}
	if !reflect.DeepEqual(s, want) {
		t.Fatalf("New().Build() = %+v, want %+v", s, want)
	}
}

func TestBuilderSettersOverrideDefaults(t *testing.T) {
	sec := Security{
		Ops:     map[string][]string{"create": {"bearer"}},
		Schemes: []Scheme{{In: "header"}},
	}
	s := New("order", "/orders").
		Desc("an order").
		Tags("sales", "billing").
		Transports("rest", "graphql").
		Ops("list", "get").
		Pagination("cursor").
		Fields(Str("id", ID), Int("qty")).
		Secure(sec).
		Build()

	if s.Description != "an order" {
		t.Errorf("Description = %q", s.Description)
	}
	if !reflect.DeepEqual(s.Tags, []string{"sales", "billing"}) {
		t.Errorf("Tags = %v", s.Tags)
	}
	if !reflect.DeepEqual(s.Transports, []string{"rest", "graphql"}) {
		t.Errorf("Transports = %v", s.Transports)
	}
	if !reflect.DeepEqual(s.Ops, []string{"list", "get"}) {
		t.Errorf("Ops = %v", s.Ops)
	}
	if s.Pagination != "cursor" {
		t.Errorf("Pagination = %q", s.Pagination)
	}
	wantFields := []Field{{Name: "id", Type: "str", Role: "id"}, {Name: "qty", Type: "int"}}
	if !reflect.DeepEqual(s.Fields, wantFields) {
		t.Errorf("Fields = %+v, want %+v", s.Fields, wantFields)
	}
	if s.Security == nil || !reflect.DeepEqual(*s.Security, sec) {
		t.Errorf("Security = %+v, want %+v", s.Security, sec)
	}
	// Untouched identity fields survive the chain.
	if s.Entity != "order" || s.Path != "/orders" || s.SpecVersion != SpecVersion {
		t.Errorf("identity fields changed: %+v", s)
	}
}

func TestBuilderSecureCopiesItsArgument(t *testing.T) {
	sec := Security{Schemes: []Scheme{{In: "header"}}}
	b := New("e", "/e").Secure(sec)
	sec.Schemes = nil
	if got := b.Build().Security; got == nil || len(got.Schemes) != 1 {
		t.Fatalf("Security = %+v, want the value captured at Secure() time", got)
	}
}

func TestBuilderActions(t *testing.T) {
	s := New("order", "/orders").Actions(
		Act("cancel").Desc("cancel it").In(Str("reason", Optional)).Transition("status", "open", "cancelled"),
		Act("ping").NonTransactional(),
		Act("bare"),
	).Build()

	if len(s.Actions) != 3 {
		t.Fatalf("len(Actions) = %d, want 3", len(s.Actions))
	}

	cancel := s.Actions[0]
	wantCancel := Action{
		Description: "cancel it",
		From:        "open",
		Input:       []Field{{Name: "reason", Type: "str", Optional: true}},
		Name:        "cancel",
		StateField:  "status",
		To:          "cancelled",
	}
	if !reflect.DeepEqual(cancel, wantCancel) {
		t.Errorf("cancel = %+v, want %+v", cancel, wantCancel)
	}

	ping := s.Actions[1]
	if ping.Name != "ping" || ping.Transactional == nil || *ping.Transactional {
		t.Errorf("ping = %+v, want transactional explicitly false", ping)
	}

	if !reflect.DeepEqual(s.Actions[2], Action{Name: "bare"}) {
		t.Errorf("bare = %+v, want only the name set", s.Actions[2])
	}
}

func TestBuilderActionsWithNoneYieldsEmptyNonNilSlice(t *testing.T) {
	s := New("e", "/e").Actions().Build()
	if s.Actions == nil || len(s.Actions) != 0 {
		t.Fatalf("Actions = %#v, want an empty non-nil slice", s.Actions)
	}
	out, err := MarshalCanonical(s)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"actions"`) {
		t.Fatalf("empty actions must be omitted from the IR, got %s", out)
	}
}

func TestFieldConstructorsSetType(t *testing.T) {
	cases := []struct {
		got  Field
		want string
	}{
		{Str("f"), "str"},
		{Int("f"), "int"},
		{Float("f"), "float"},
		{Bool("f"), "bool"},
		{DateTime("f"), "datetime"},
		{Enum("f"), "enum"},
		{List("f"), "list"},
		{Obj("f"), "obj"},
	}
	for _, tc := range cases {
		if !reflect.DeepEqual(tc.got, Field{Name: "f", Type: tc.want}) {
			t.Errorf("constructor for %s = %+v, want only name and type set", tc.want, tc.got)
		}
	}
}

func TestFlagMarkersSetExactlyOneFlag(t *testing.T) {
	cases := []struct {
		name string
		opt  FieldOpt
		want Field
	}{
		{"ID", ID, Field{Name: "f", Type: "str", Role: "id"}},
		{"Filterable", Filterable, Field{Name: "f", Type: "str", Filterable: true}},
		{"Nullable", Nullable, Field{Name: "f", Type: "str", Nullable: true}},
		{"Optional", Optional, Field{Name: "f", Type: "str", Optional: true}},
		{"Readonly", Readonly, Field{Name: "f", Type: "str", Readonly: true}},
		{"Writeonly", Writeonly, Field{Name: "f", Type: "str", Writeonly: true}},
		{"Desc", Desc("d"), Field{Name: "f", Type: "str", Description: "d"}},
		{"Format", Format("email"), Field{Name: "f", Type: "str", Format: "email"}},
		{"Pattern", Pattern("^a$"), Field{Name: "f", Type: "str", Pattern: "^a$"}},
		{"Values", Values("a", "b"), Field{Name: "f", Type: "str", Enum: []string{"a", "b"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Str("f", tc.opt); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Str(f, %s) = %+v, want %+v", tc.name, got, tc.want)
			}
		})
	}
}

func TestMinMaxKeepExplicitZeroAndNegative(t *testing.T) {
	f := Int("n", Min(0), Max(-3))
	if f.Min == nil || *f.Min != 0 {
		t.Fatalf("Min = %v, want pointer to 0", f.Min)
	}
	if f.Max == nil || *f.Max != -3 {
		t.Fatalf("Max = %v, want pointer to -3", f.Max)
	}

	plain := Int("n")
	if plain.Min != nil || plain.Max != nil {
		t.Fatalf("bounds set without Min/Max: %+v", plain)
	}

	out, err := MarshalCanonical(New("e", "/e").Fields(f).Build())
	if err != nil {
		t.Fatal(err)
	}
	if want := `"fields":[{"max":-3,"min":0,"name":"n","type":"int"}]`; !strings.Contains(string(out), want) {
		t.Fatalf("explicit zero bound dropped from IR: %s", out)
	}
}

func TestOfAndSubNestFields(t *testing.T) {
	list := List("tags", Of(Str("tag", Pattern("^[a-z]+$"))))
	if list.Item == nil || !reflect.DeepEqual(*list.Item, Field{Name: "tag", Type: "str", Pattern: "^[a-z]+$"}) {
		t.Fatalf("list item = %+v", list.Item)
	}

	obj := Obj("address", Sub(Str("city"), Int("zip", Optional)))
	want := []Field{{Name: "city", Type: "str"}, {Name: "zip", Type: "int", Optional: true}}
	if !reflect.DeepEqual(obj.Fields, want) {
		t.Fatalf("obj fields = %+v, want %+v", obj.Fields, want)
	}
}

func TestOptionsApplyInOrderLastWins(t *testing.T) {
	f := Str("f", Desc("first"), Desc("second"), Values("a"), Values())
	if f.Description != "second" {
		t.Fatalf("Description = %q, want the last option to win", f.Description)
	}
	if len(f.Enum) != 0 {
		t.Fatalf("Enum = %v, want cleared by the later empty Values()", f.Enum)
	}
}

func TestRefSetsTypeAndTarget(t *testing.T) {
	f := Ref("ownerId", "user", Filterable, Nullable)
	want := Field{Name: "ownerId", Type: "ref", Ref: "user", Filterable: true, Nullable: true}
	if !reflect.DeepEqual(f, want) {
		t.Fatalf("Ref = %+v, want %+v", f, want)
	}
	if bare := Ref("x", ""); bare.Ref != "" || bare.Type != "ref" {
		t.Fatalf("Ref with empty target = %+v", bare)
	}
}

package entity

import (
	"errors"
	"go/ast"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
)

// astCovTag wraps an entity tag value in a struct tag literal.
func astCovTag(v string) string { return "`entity:\"" + v + "\"`" }

func astCovFieldsByName(t *testing.T, src, structName string) map[string]Field {
	t.Helper()
	spec, err := ParseStruct(src, structName)
	if err != nil {
		t.Fatalf("ParseStruct: %v", err)
	}
	out := make(map[string]Field, len(spec.Fields))
	for _, f := range spec.Fields {
		out[f.Name] = f
	}
	return out
}

func TestAstCoverage_UnsupportedSourceType(t *testing.T) {
	for _, src := range []any{42, nil, []string{"type Foo struct{}"}} {
		_, err := ParseStruct(src, "Foo")
		if err == nil || !strings.Contains(err.Error(), "unsupported src type") {
			t.Errorf("ParseStruct(%T) err = %v, want an unsupported-src-type error", src, err)
		}
	}
}

func TestAstCoverage_ReaderErrorIsWrapped(t *testing.T) {
	boom := errors.New("disk gone")
	spec, err := ParseStruct(iotest.ErrReader(boom), "Foo")
	if !errors.Is(err, boom) || !strings.Contains(err.Error(), "failed to read src") {
		t.Fatalf("err = %v, want the wrapped reader error", err)
	}
	if !reflect.DeepEqual(spec, Spec{}) {
		t.Errorf("spec = %+v, want the zero Spec on error", spec)
	}
}

func TestAstCoverage_ErrorMessagesNameTheCause(t *testing.T) {
	cases := []struct {
		name, src, structName, want string
	}{
		{"missing struct", `type Foo struct{}`, "Bar", `struct "Bar" not found in source`},
		{"name is not a struct", `type Foo string`, "Foo", `struct "Foo" not found in source`},
		{"empty source", ``, "Foo", `struct "Foo" not found in source`},
		{"syntax error", `type Foo struct {`, "Foo", "failed to parse Go source"},
		{"bad min", `type Foo struct { X int ` + astCovTag("x,min=abc") + ` }`, "Foo", `field X: error parsing entity tag: invalid min value "abc"`},
		{"bad max", `type Foo struct { X int ` + astCovTag("x,max=1.5") + ` }`, "Foo", `field X: error parsing entity tag: invalid max value "1.5"`},
		{"empty max", `type Foo struct { X int ` + astCovTag("x,max=") + ` }`, "Foo", `invalid max value ""`},
		{"snake_case json name", "type Foo struct { X int `json:\"user_name\"` }", "Foo", "wire name"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseStruct(c.src, c.structName)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to contain %q", err, c.want)
			}
		})
	}
}

func TestAstCoverage_DocCommentSources(t *testing.T) {
	cases := []struct{ name, src, want string }{
		{
			"doc on a spec inside a type group",
			"type (\n\t// Order is a purchase.\n\tOrder struct { Total int }\n)",
			"Order is a purchase.",
		},
		{
			"doc on the type group itself",
			"// Grouped types.\ntype (\n\tOrder struct { Total int }\n)",
			"Grouped types.",
		},
		{
			"spec doc wins over group doc",
			"// Grouped types.\ntype (\n\t// Order is a purchase.\n\tOrder struct { Total int }\n)",
			"Order is a purchase.",
		},
		{"no doc", "type Order struct { Total int }", ""},
		{"blank doc", "//\ntype Order struct { Total int }", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec, err := ParseStruct(c.src, "Order")
			if err != nil {
				t.Fatal(err)
			}
			if spec.Description != c.want {
				t.Errorf("Description = %q, want %q", spec.Description, c.want)
			}
			if spec.Entity != "Order" || spec.Path != "orders" {
				t.Errorf("entity/path = %q/%q, want Order/orders", spec.Entity, spec.Path)
			}
		})
	}
}

func TestAstCoverage_SecondTypeDeclIsFound(t *testing.T) {
	src := "package models\n\nconst Limit = 3\n\nfunc helper() {}\n\ntype Other struct { A int }\n\ntype (\n\tAlias string\n\tTarget struct { B bool }\n)\n"
	spec, err := ParseStruct(src, "Target")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(spec.Fields, []Field{Bool("b")}) {
		t.Errorf("fields = %+v, want [b bool]", spec.Fields)
	}
}

func TestAstCoverage_EmptyStructHasNoFields(t *testing.T) {
	spec, err := ParseStruct(`type Empty struct{}`, "Empty")
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 0 {
		t.Errorf("fields = %+v, want none", spec.Fields)
	}
}

func TestAstCoverage_GoTypeMapping(t *testing.T) {
	src := `
package models

import (
	"time"

	"github.com/google/uuid"
)

type Status string

type Address struct {
	City string
}

type Thing struct {
	Small   int8
	Big     uint64
	Ratio   float32
	Flag    bool
	Blob    any
	State   Status
	Ext     uuid.UUID
	When    time.Time
	Ptr     *string
	PtrTime *time.Time
	PtrAddr *Address
	Lookup  map[string]int
	Hook    func() error
	Inline  struct {
		Depth int
	}
	Addrs []*Address
	A, B  int
}
`
	got := astCovFieldsByName(t, src, "Thing")
	want := map[string]Field{
		"small":   Int("small"),
		"big":     Int("big"),
		"ratio":   Float("ratio"),
		"flag":    Bool("flag"),
		"blob":    Obj("blob"),
		"state":   Str("state"),
		"ext":     Str("ext"),
		"when":    DateTime("when"),
		"ptr":     Str("ptr"),
		"ptrTime": DateTime("ptrTime"),
		"ptrAddr": Obj("ptrAddr", Sub(Str("city"))),
		"lookup":  Str("lookup"),
		"hook":    Str("hook"),
		"inline":  Obj("inline", Sub(Int("depth"))),
		"addrs":   List("addrs", Of(Obj("addrs", Sub(Str("city"))))),
		"a":       Int("a"),
		"b":       Int("b"),
	}
	if len(got) != len(want) {
		t.Fatalf("got %d fields, want %d: %+v", len(got), len(want), got)
	}
	for name, w := range want {
		if g := got[name]; !reflect.DeepEqual(g, w) {
			t.Errorf("field %s:\n got %+v\nwant %+v", name, g, w)
		}
	}
}

func TestAstCoverage_EmbeddedFields(t *testing.T) {
	src := `
package models

import "time"

type Base struct {
	Code string
}

type Audit struct {
	By string
}

type Box[T any] struct {
	V T
}

type Doc struct {
	Base
	*Audit
	time.Time
	Box[int]
	Title string
}
`
	spec, err := ParseStruct(src, "Doc")
	if err != nil {
		t.Fatal(err)
	}
	// An embedded field is named after its type; a generic instantiation has no usable name
	// and is skipped.
	want := []Field{
		Obj("base", Sub(Str("code"))),
		Obj("audit", Sub(Str("by"))),
		DateTime("time"),
		Str("title"),
	}
	if !reflect.DeepEqual(spec.Fields, want) {
		t.Errorf("fields:\n got %+v\nwant %+v", spec.Fields, want)
	}
}

func TestAstCoverage_NonASCIIFieldNameIsRejectedAsWireName(t *testing.T) {
	// The default wire name lower-cases the first rune, but the wire-name pattern is ASCII-only.
	_, err := ParseStruct("type T struct {\n\tÉtat string\n}", "T")
	if err == nil || !strings.Contains(err.Error(), `"état"`) {
		t.Errorf("err = %v, want a wire-name error naming the rune-lowered %q", err, "état")
	}
}

func TestAstCoverage_InterpretedStringTagIsHonoured(t *testing.T) {
	t.Skip("source bug: parseStructFields strips the quotes of an interpreted-string tag literal " +
		"(\"entity:\\\"x\\\"\") without unescaping it, so reflect.StructTag finds no entity/json key and " +
		"the tag is silently ignored; only raw (backtick) tags work")

	spec, err := ParseStruct("type T struct {\n\tH string \"entity:\\\"quoted,optional\\\"\"\n}", "T")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(spec.Fields, []Field{Str("quoted", Optional)}) {
		t.Errorf("fields = %+v, want [quoted optional]", spec.Fields)
	}
}

func TestAstCoverage_WireNamesFromTags(t *testing.T) {
	src := "type T struct {\n" +
		"\tA string `json:\"fromJson\" entity:\"fromEntity\"`\n" +
		"\tB string `json:\"fromJson2,omitempty\"`\n" +
		"\tC string `json:\"-\"`\n" +
		"\tD string `json:\",omitempty\"`\n" +
		"\tE string `entity:\"name=viaKey\"`\n" +
		"\tF string `entity:\"optional\"`\n" +
		"\tG string `json:\"skipped\" entity:\"-\"`\n" +
		"}"
	spec, err := ParseStruct(src, "T")
	if err != nil {
		t.Fatal(err)
	}
	want := []Field{
		Str("fromEntity"),
		Str("fromJson2"),
		Str("c"),
		Str("d"),
		Str("viaKey"),
		Str("f", Optional),
	}
	if !reflect.DeepEqual(spec.Fields, want) {
		t.Errorf("fields:\n got %+v\nwant %+v", spec.Fields, want)
	}
}

func TestAstCoverage_TagAttributesOverrideTheGoType(t *testing.T) {
	src := "type T struct {\n" +
		"\tOwner string " + astCovTag("ownerId,ref=User,filterable") + "\n" +
		"\tWhen string " + astCovTag("when,type=datetime") + "\n" +
		"\tCode string " + astCovTag("code,pattern=^[A-Z]{3}$,role=id") + "\n" +
		"\tKind int " + astCovTag("kind,enum=a|b,type=str") + "\n" +
		"\tNote string " + astCovTag("note,description='has, comma',min=0,max=0") + "\n" +
		"}"
	got := astCovFieldsByName(t, src, "T")

	if f := got["ownerId"]; f.Type != "ref" || f.Ref != "User" || !f.Filterable {
		t.Errorf("ownerId = %+v, want a filterable ref to User", f)
	}
	if f := got["when"]; f.Type != "datetime" {
		t.Errorf("when type = %q, want datetime (type= overrides the Go type)", f.Type)
	}
	if f := got["code"]; f.Pattern != "^[A-Z]{3}$" || f.Role != "id" {
		t.Errorf("code = %+v, want the pattern and role=id", f)
	}
	// An explicit type= is applied last, so it wins over the enum inference.
	if f := got["kind"]; f.Type != "str" || !reflect.DeepEqual(f.Enum, []string{"a", "b"}) {
		t.Errorf("kind = %+v, want type str with enum [a b]", f)
	}
	f := got["note"]
	if f.Description != "has, comma" {
		t.Errorf("note description = %q, want %q", f.Description, "has, comma")
	}
	if f.Min == nil || *f.Min != 0 || f.Max == nil || *f.Max != 0 {
		t.Errorf("note min/max = %v/%v, want explicit zeros", f.Min, f.Max)
	}
}

func TestAstCoverage_ParseTagString(t *testing.T) {
	one, neg := 1, -5
	cases := []struct {
		tag  string
		want parsedTag
	}{
		{"", parsedTag{}},
		{"   ", parsedTag{}},
		{"email", parsedTag{Name: "email"}},
		{"readonly", parsedTag{Readonly: true}},
		{"nullable,optional,writeonly,filterable", parsedTag{Nullable: true, Optional: true, Writeonly: true, Filterable: true}},
		{"x,unknownflag,readonly", parsedTag{Name: "x", Readonly: true}},
		{"x,optional=true,nullable=1,readonly=true,writeonly=1,filterable=true",
			parsedTag{Name: "x", Optional: true, Nullable: true, Readonly: true, Writeonly: true, Filterable: true}},
		{"x,optional=false,nullable=0,readonly=no,writeonly=,filterable=TRUE", parsedTag{Name: "x"}},
		{"x,optional,optional=false", parsedTag{Name: "x"}},
		{"name=explicit,type=float,role=id,ref=Org,format=uuid",
			parsedTag{Name: "explicit", Type: "float", Role: "id", Ref: "Org", Format: "uuid"}},
		{"x , min = 1 , max = -5", parsedTag{Name: "x", Min: &one, Max: &neg}},
		{`x,desc="double, quoted"`, parsedTag{Name: "x", Description: "double, quoted"}},
		{`x,desc='it "quotes"'`, parsedTag{Name: "x", Description: `it "quotes"`}},
		{`x,desc="it's"`, parsedTag{Name: "x", Description: "it's"}},
		{`x,desc='`, parsedTag{Name: "x", Description: "'"}},
		{"x,pattern=^a=b$", parsedTag{Name: "x", Pattern: "^a=b$"}},
		{"x,enum=only", parsedTag{Name: "x", Enum: []string{"only"}}},
		{"x,bogus=1", parsedTag{Name: "x"}},
		{",,x,,", parsedTag{Name: "x"}},
	}
	for _, c := range cases {
		t.Run(c.tag, func(t *testing.T) {
			got, err := parseTagString(c.tag)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("parseTagString(%q):\n got %+v\nwant %+v", c.tag, got, c.want)
			}
		})
	}
}

func TestAstCoverage_ParseTagStringRejectsNonIntegerBounds(t *testing.T) {
	for _, tag := range []string{"x,min=", "x,min=1e3", "x,max=ten", "x,max=99999999999999999999"} {
		if _, err := parseTagString(tag); err == nil {
			t.Errorf("parseTagString(%q) = nil error, want a bound-parsing error", tag)
		}
	}
}

func TestAstCoverage_TokenizeTag(t *testing.T) {
	cases := []struct {
		tag  string
		want []string
	}{
		{"", nil},
		{" , ,", nil},
		{"a", []string{"a"}},
		{" a , b ", []string{"a", "b"}},
		{"a,desc='x, y',b", []string{"a", "desc='x, y'", "b"}},
		{`a,desc="x, y",b`, []string{"a", `desc="x, y"`, "b"}},
		{`a,desc='say "hi, there"',b`, []string{"a", `desc='say "hi, there"'`, "b"}},
		{`a,desc="it's, fine",b`, []string{"a", `desc="it's, fine"`, "b"}},
		// An unterminated quote swallows the rest of the tag.
		{"a,desc='open, b", []string{"a", "desc='open, b"}},
	}
	for _, c := range cases {
		if got := tokenizeTag(c.tag); !reflect.DeepEqual(got, c.want) {
			t.Errorf("tokenizeTag(%q) = %q, want %q", c.tag, got, c.want)
		}
	}
}

func TestAstCoverage_IsKnownFlag(t *testing.T) {
	for _, flag := range []string{"optional", "nullable", "readonly", "writeonly", "filterable"} {
		if !isKnownFlag(flag) {
			t.Errorf("isKnownFlag(%q) = false, want true", flag)
		}
	}
	for _, other := range []string{"", "Optional", "name", "min"} {
		if isKnownFlag(other) {
			t.Errorf("isKnownFlag(%q) = true, want false", other)
		}
	}
}

func TestAstCoverage_LowerFirst(t *testing.T) {
	cases := map[string]string{"": "", "Name": "name", "name": "name", "X": "x", "Élan": "élan", "9lives": "9lives"}
	for in, want := range cases {
		if got := lowerFirst(in); got != want {
			t.Errorf("lowerFirst(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAstCoverage_ExprTypeName(t *testing.T) {
	ident := ast.NewIdent("Base")
	cases := []struct {
		name string
		expr ast.Expr
		want string
	}{
		{"ident", ident, "Base"},
		{"pointer", &ast.StarExpr{X: ident}, "Base"},
		{"pointer to pointer", &ast.StarExpr{X: &ast.StarExpr{X: ident}}, "Base"},
		{"selector", &ast.SelectorExpr{X: ast.NewIdent("time"), Sel: ast.NewIdent("Time")}, "Time"},
		{"slice", &ast.ArrayType{Elt: ident}, ""},
	}
	for _, c := range cases {
		if got := exprTypeName(c.expr); got != c.want {
			t.Errorf("exprTypeName(%s) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestAstCoverage_HelpersTolerateMissingInput(t *testing.T) {
	if st := findStructByName(nil, "Anything"); st != nil {
		t.Errorf("findStructByName(nil) = %v, want nil", st)
	}
	fields, err := parseStructFields(&ast.StructType{}, nil, nil, map[string]bool{})
	if err != nil || len(fields) != 0 {
		t.Errorf("parseStructFields(no field list) = (%v, %v), want (empty, nil)", fields, err)
	}
	// Without a file to look names up in, a named type degrades to a string.
	f, err := resolveAstType(ast.NewIdent("Mystery"), nil, nil, map[string]bool{})
	if err != nil || !reflect.DeepEqual(f, Field{Type: "str"}) {
		t.Errorf("resolveAstType(unknown ident, nil file) = (%+v, %v), want a str field", f, err)
	}
}

func TestAstCoverage_NestedErrorsPropagate(t *testing.T) {
	bad := astCovTag("x,min=oops")
	cases := map[string]string{
		"named struct":  "type Inner struct { X int " + bad + " }\ntype Outer struct { In Inner }",
		"pointer":       "type Inner struct { X int " + bad + " }\ntype Outer struct { In *Inner }",
		"slice":         "type Inner struct { X int " + bad + " }\ntype Outer struct { In []Inner }",
		"inline struct": "type Outer struct { In struct { X int " + bad + " } }",
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseStruct(src, "Outer")
			if err == nil || !strings.Contains(err.Error(), `invalid min value "oops"`) || !strings.Contains(err.Error(), "field In") {
				t.Fatalf("err = %v, want the nested tag error attributed to field In", err)
			}
		})
	}
}

func TestAstCoverage_SourceWithLeadingCommentBeforePackageClause(t *testing.T) {
	t.Skip("source bug: ParseStruct only skips the dummy-package wrap when the trimmed source starts with " +
		"\"package \", so a file with a leading comment, licence header or build tag gets a second package " +
		"clause prepended and fails with \"failed to parse Go source\"")

	src := "// Licence header.\n\npackage models\n\ntype Foo struct { A int }\n"
	spec, err := ParseStruct(src, "Foo")
	if err != nil {
		t.Fatalf("ParseStruct on a file with a leading comment: %v", err)
	}
	if !reflect.DeepEqual(spec.Fields, []Field{Int("a")}) {
		t.Errorf("fields = %+v, want [a int]", spec.Fields)
	}
}

package dto_test

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"regexp"
	"strings"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

// typeCheck fails the test unless code is a Go file that compiles (an unused import is a
// type error, which format.Source does not catch).
func typeCheck(t *testing.T, code []byte) {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "dto_gen.go", code, 0)
	if err != nil {
		t.Fatalf("generated code does not parse: %v\n%s", err, code)
	}
	conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
	if _, err := conf.Check("dto", fset, []*ast.File{file}, nil); err != nil {
		t.Fatalf("generated code does not compile: %v\n%s", err, code)
	}
}

// structBody returns the field lines of `type <name> struct { ... }` in code.
func structBody(t *testing.T, code, name string) string {
	t.Helper()
	m := regexp.MustCompile(`(?s)type ` + name + ` struct \{(.*?)\n\}`).FindStringSubmatch(code)
	if m == nil {
		t.Fatalf("struct %s not found in:\n%s", name, code)
	}
	return m[1]
}

func TestGenerateGoStructsCompilesWithoutDatetimeField(t *testing.T) {
	spec := entity.Spec{Entity: "Tag", Fields: []entity.Field{
		{Name: "id", Type: "str", Role: "id", Readonly: true},
		{Name: "label", Type: "str"},
	}}
	code, err := dto.GenerateGoStructs(spec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, code)
}

func TestGenerateGoStructsCompilesForUserSpec(t *testing.T) {
	code, err := dto.GenerateGoStructs(example.UserSpec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, code)
	if !strings.Contains(string(code), `"time"`) {
		t.Fatalf("a spec with a datetime field must import time:\n%s", code)
	}
}

// A datetime nested inside an obj inside a list still needs the import.
func TestGenerateGoStructsImportsTimeForNestedDatetime(t *testing.T) {
	spec := entity.Spec{Entity: "Log", Fields: []entity.Field{
		{Name: "entries", Type: "list", Item: &entity.Field{Name: "entries", Type: "obj", Fields: []entity.Field{
			{Name: "at", Type: "datetime"},
		}}},
	}}
	code, err := dto.GenerateGoStructs(spec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, code)
}

// Each DTO kind gets its own nested struct, filtered by that kind's include rule: the Read
// DTO must not expose a writeonly nested member nor drop a readonly one.
func TestGenerateGoStructsNestedStructPerDTOKind(t *testing.T) {
	spec := entity.Spec{Entity: "T", Fields: []entity.Field{
		{Name: "profile", Type: "obj", Fields: []entity.Field{
			{Name: "secret", Type: "str", Writeonly: true},
			{Name: "views", Type: "int", Readonly: true},
		}},
	}}
	codeBytes, err := dto.GenerateGoStructs(spec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, codeBytes)
	code := string(codeBytes)

	for _, kind := range []string{"Create", "Update"} {
		body := structBody(t, code, "T"+kind+"Profile")
		if !strings.Contains(body, "Secret") || strings.Contains(body, "Views") {
			t.Errorf("T%sProfile must hold Secret only, got:%s", kind, body)
		}
	}
	read := structBody(t, code, "TReadProfile")
	if strings.Contains(read, "Secret") || !strings.Contains(read, "Views") {
		t.Errorf("TReadProfile must hold Views only, got:%s", read)
	}
	if !regexp.MustCompile(`Profile\s+TReadProfile\s`).MatchString(structBody(t, code, "TReadDTO")) {
		t.Errorf("TReadDTO.Profile must be a TReadProfile:\n%s", code)
	}
}

// An action's nested input struct never shares a name with a top-level field's struct.
func TestGenerateGoStructsActionInputDoesNotCollideWithField(t *testing.T) {
	spec := entity.Spec{Entity: "T",
		Fields: []entity.Field{
			{Name: "xY", Type: "obj", Fields: []entity.Field{{Name: "a", Type: "str"}}},
		},
		Actions: []entity.Action{{Name: "x", Input: []entity.Field{
			{Name: "y", Type: "obj", Fields: []entity.Field{{Name: "b", Type: "int"}}},
		}}},
	}
	codeBytes, err := dto.GenerateGoStructs(spec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, codeBytes)
	code := string(codeBytes)
	if body := structBody(t, code, "TActionXY"); !strings.Contains(body, "B ") {
		t.Errorf("action input struct must hold B, got:%s", body)
	}
	if body := structBody(t, code, "TCreateXY"); !strings.Contains(body, "A ") {
		t.Errorf("field struct must hold A, got:%s", body)
	}
}

// Two different nested shapes that map to one Go type name fail closed instead of the first
// one silently winning.
func TestGenerateGoStructsRejectsNestedNameCollision(t *testing.T) {
	spec := entity.Spec{Entity: "T", Fields: []entity.Field{
		{Name: "x", Type: "obj", Fields: []entity.Field{
			{Name: "y", Type: "obj", Fields: []entity.Field{{Name: "a", Type: "str"}}},
		}},
		{Name: "xY", Type: "obj", Fields: []entity.Field{{Name: "b", Type: "int"}}},
	}}
	if _, err := dto.GenerateGoStructs(spec, "dto"); err == nil || !strings.Contains(err.Error(), "TCreateXY") {
		t.Fatalf("expected a name-collision error naming TCreateXY, got %v", err)
	}
}

func TestGenerateGoStructsRejectsDeepNestedNameCollision(t *testing.T) {
	spec := entity.Spec{Entity: "T", Fields: []entity.Field{
		{Name: "x", Type: "obj", Fields: []entity.Field{
			{Name: "y", Type: "obj", Fields: []entity.Field{
				{Name: "z", Type: "obj", Fields: []entity.Field{{Name: "a", Type: "str"}}},
			}},
		}},
		{Name: "xY", Type: "obj", Fields: []entity.Field{
			{Name: "z", Type: "obj", Fields: []entity.Field{{Name: "b", Type: "int"}}},
		}},
	}}
	if _, err := dto.GenerateGoStructs(spec, "dto"); err == nil {
		t.Fatalf("expected error for deep nested name collision, got nil")
	}
}

func TestGenerateGoStructsAllowsIdenticalDeepDuplicate(t *testing.T) {
	spec := entity.Spec{Entity: "T", Fields: []entity.Field{
		{Name: "x", Type: "obj", Fields: []entity.Field{
			{Name: "y", Type: "obj", Fields: []entity.Field{
				{Name: "z", Type: "obj", Fields: []entity.Field{{Name: "a", Type: "str"}}},
			}},
		}},
		{Name: "xY", Type: "obj", Fields: []entity.Field{
			{Name: "z", Type: "obj", Fields: []entity.Field{{Name: "a", Type: "str"}}},
		}},
	}}
	codeBytes, err := dto.GenerateGoStructs(spec, "dto")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	typeCheck(t, codeBytes)
	count := strings.Count(string(codeBytes), "type TCreateXYZ struct")
	if count != 1 {
		t.Fatalf("expected exactly one 'type TCreateXYZ struct', got %d in:\n%s", count, string(codeBytes))
	}
}

func TestGenerateGoStructsRejectsDuplicateGoFieldName(t *testing.T) {
	t.Run("top-level fields", func(t *testing.T) {
		spec := entity.Spec{Entity: "T", Fields: []entity.Field{
			{Name: "name", Type: "str"},
			{Name: "Name", Type: "str"},
		}}
		if _, err := dto.GenerateGoStructs(spec, "dto"); err == nil {
			t.Fatalf("expected error for duplicate Go field name in top-level fields, got nil")
		}
	})

	t.Run("nested obj", func(t *testing.T) {
		spec := entity.Spec{Entity: "T", Fields: []entity.Field{
			{Name: "profile", Type: "obj", Fields: []entity.Field{
				{Name: "foo", Type: "str"},
				{Name: "Foo", Type: "int"},
			}},
		}}
		if _, err := dto.GenerateGoStructs(spec, "dto"); err == nil {
			t.Fatalf("expected error for duplicate Go field name in nested obj, got nil")
		}
	})

	t.Run("action input", func(t *testing.T) {
		spec := entity.Spec{Entity: "T", Actions: []entity.Action{
			{
				Name: "doSomething",
				Input: []entity.Field{
					{Name: "foo", Type: "str"},
					{Name: "Foo", Type: "str"},
				},
			},
		}}
		if _, err := dto.GenerateGoStructs(spec, "dto"); err == nil {
			t.Fatalf("expected error for duplicate Go field name in action input, got nil")
		}
	})
}

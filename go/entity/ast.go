package entity

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode"
)

// ParseStruct parses a Go struct definition from src and extracts an entity Spec.
// src can be string, []byte, or io.Reader.
func ParseStruct(src any, structName string) (Spec, error) {
	var srcBytes []byte
	switch s := src.(type) {
	case string:
		srcBytes = []byte(s)
	case []byte:
		srcBytes = s
	case io.Reader:
		b, err := io.ReadAll(s)
		if err != nil {
			return Spec{}, fmt.Errorf("failed to read src: %w", err)
		}
		srcBytes = b
	default:
		return Spec{}, fmt.Errorf("unsupported src type: %T", src)
	}

	// If the source does not declare a package, wrap it in a dummy package for parser
	content := string(srcBytes)
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "package ") {
		content = "package dummy\n" + content
	}

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "", content, parser.ParseComments)
	if err != nil {
		return Spec{}, fmt.Errorf("failed to parse Go source: %w", err)
	}

	var targetTypeSpec *ast.TypeSpec
	var targetStructType *ast.StructType
	var docComment *ast.CommentGroup

	for _, decl := range node.Decls {
		genDecl, ok := decl.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.TYPE {
			continue
		}
		for _, spec := range genDecl.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			if ts.Name.Name == structName {
				st, ok := ts.Type.(*ast.StructType)
				if ok {
					targetTypeSpec = ts
					targetStructType = st
					if ts.Doc != nil {
						docComment = ts.Doc
					} else if genDecl.Doc != nil {
						docComment = genDecl.Doc
					}
					break
				}
			}
		}
		if targetTypeSpec != nil {
			break
		}
	}

	if targetTypeSpec == nil || targetStructType == nil {
		return Spec{}, fmt.Errorf("struct %q not found in source", structName)
	}

	builder := New(structName, strings.ToLower(structName)+"s")
	if docComment != nil {
		desc := strings.TrimSpace(docComment.Text())
		if desc != "" {
			builder.Desc(desc)
		}
	}

	fields, err := parseStructFields(targetStructType, fset, node)
	if err != nil {
		return Spec{}, err
	}
	builder.Fields(fields...)

	return builder.Build(), nil
}

func parseStructFields(st *ast.StructType, fset *token.FileSet, file *ast.File) ([]Field, error) {
	var fields []Field

	if st.Fields == nil {
		return fields, nil
	}

	for _, astField := range st.Fields.List {
		// Field tag
		var tagStr string
		if astField.Tag != nil {
			tagStr = astField.Tag.Value
			// Remove backticks or quotes around tag string
			if (strings.HasPrefix(tagStr, "`") && strings.HasSuffix(tagStr, "`")) ||
				(strings.HasPrefix(tagStr, "\"") && strings.HasSuffix(tagStr, "\"")) {
				tagStr = tagStr[1 : len(tagStr)-1]
			}
		}

		stTag := reflect.StructTag(tagStr)
		entityTag := stTag.Get("entity")
		jsonTag := stTag.Get("json")

		if entityTag == "-" {
			continue
		}

		var fieldNames []string
		if len(astField.Names) > 0 {
			for _, n := range astField.Names {
				fieldNames = append(fieldNames, n.Name)
			}
		} else {
			// Embedded struct / anonymous field
			typeName := exprTypeName(astField.Type)
			if typeName != "" {
				fieldNames = append(fieldNames, typeName)
			}
		}

		for _, name := range fieldNames {
			f, err := parseField(name, astField.Type, entityTag, jsonTag, fset, file)
			if err != nil {
				return nil, err
			}
			fields = append(fields, f)
		}
	}

	return fields, nil
}

func parseField(goFieldName string, astType ast.Expr, entityTag, jsonTag string, fset *token.FileSet, file *ast.File) (Field, error) {
	// Parse entity tag attributes
	tagAttrs, err := parseTagString(entityTag)
	if err != nil {
		return Field{}, fmt.Errorf("field %s: error parsing entity tag: %w", goFieldName, err)
	}

	fieldName := tagAttrs.Name
	if fieldName == "" && jsonTag != "" {
		parts := strings.Split(jsonTag, ",")
		if parts[0] != "" && parts[0] != "-" {
			fieldName = parts[0]
		}
	}
	if fieldName == "" {
		// default to lower-camel-case of goFieldName
		fieldName = lowerFirst(goFieldName)
	}

	// Resolve type
	f, err := resolveAstType(astType, fset, file)
	if err != nil {
		return Field{}, fmt.Errorf("field %s: %w", goFieldName, err)
	}
	f.Name = fieldName

	// Apply tag attributes
	if tagAttrs.Description != "" {
		f.Description = tagAttrs.Description
	}
	if len(tagAttrs.Enum) > 0 {
		f.Enum = tagAttrs.Enum
		f.Type = "enum"
	}
	if tagAttrs.Filterable {
		f.Filterable = true
	}
	if tagAttrs.Format != "" {
		f.Format = tagAttrs.Format
	}
	if tagAttrs.Max != nil {
		f.Max = tagAttrs.Max
	}
	if tagAttrs.Min != nil {
		f.Min = tagAttrs.Min
	}
	if tagAttrs.Nullable {
		f.Nullable = true
	}
	if tagAttrs.Optional {
		f.Optional = true
	}
	if tagAttrs.Pattern != "" {
		f.Pattern = tagAttrs.Pattern
	}
	if tagAttrs.Readonly {
		f.Readonly = true
	}
	if tagAttrs.Role != "" {
		f.Role = tagAttrs.Role
	}
	if tagAttrs.Ref != "" {
		f.Ref = tagAttrs.Ref
		f.Type = "ref"
	}
	if tagAttrs.Type != "" {
		f.Type = tagAttrs.Type
	}
	if tagAttrs.Writeonly {
		f.Writeonly = true
	}

	// If item name is needed for list item
	if f.Type == "list" && f.Item != nil && f.Item.Name == "" {
		f.Item.Name = f.Name
	}

	return f, nil
}

func resolveAstType(expr ast.Expr, fset *token.FileSet, file *ast.File) (Field, error) {
	switch t := expr.(type) {
	case *ast.Ident:
		switch t.Name {
		case "string":
			return Field{Type: "str"}, nil
		case "int", "int8", "int16", "int32", "int64",
			"uint", "uint8", "uint16", "uint32", "uint64":
			return Field{Type: "int"}, nil
		case "float32", "float64":
			return Field{Type: "float"}, nil
		case "bool":
			return Field{Type: "bool"}, nil
		case "any":
			return Field{Type: "obj"}, nil
		default:
			// Named type in the same file/package or embedded struct
			st := findStructByName(file, t.Name)
			if st != nil {
				subFields, err := parseStructFields(st, fset, file)
				if err != nil {
					return Field{}, err
				}
				return Field{Type: "obj", Fields: subFields}, nil
			}
			return Field{Type: "str"}, nil
		}

	case *ast.SelectorExpr:
		pkgIdent, ok := t.X.(*ast.Ident)
		if ok && pkgIdent.Name == "time" && t.Sel.Name == "Time" {
			return Field{Type: "datetime"}, nil
		}
		return Field{Type: "str"}, nil

	case *ast.StarExpr:
		// Pointer type - unwrap pointer
		sub, err := resolveAstType(t.X, fset, file)
		if err != nil {
			return Field{}, err
		}
		return sub, nil

	case *ast.ArrayType:
		// Slice / array: []T
		itemField, err := resolveAstType(t.Elt, fset, file)
		if err != nil {
			return Field{}, err
		}
		return Field{
			Type: "list",
			Item: &itemField,
		}, nil

	case *ast.StructType:
		// Inline anonymous struct
		subFields, err := parseStructFields(t, fset, file)
		if err != nil {
			return Field{}, err
		}
		return Field{
			Type:   "obj",
			Fields: subFields,
		}, nil

	default:
		return Field{Type: "str"}, nil
	}
}

func findStructByName(file *ast.File, name string) *ast.StructType {
	if file == nil {
		return nil
	}
	for _, decl := range file.Decls {
		genDecl, ok := decl.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.TYPE {
			continue
		}
		for _, spec := range genDecl.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			if ts.Name.Name == name {
				if st, ok := ts.Type.(*ast.StructType); ok {
					return st
				}
			}
		}
	}
	return nil
}

func exprTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return exprTypeName(t.X)
	case *ast.SelectorExpr:
		return t.Sel.Name
	default:
		return ""
	}
}

func lowerFirst(s string) string {
	if len(s) == 0 {
		return ""
	}
	r := []rune(s)
	r[0] = unicode.ToLower(r[0])
	return string(r)
}

type parsedTag struct {
	Name        string
	Role        string
	Type        string
	Ref         string
	Format      string
	Pattern     string
	Description string
	Enum        []string
	Min         *int
	Max         *int
	Nullable    bool
	Optional    bool
	Readonly    bool
	Writeonly   bool
	Filterable  bool
}

// parseTagString parses an entity tag value like:
// `email,format=email,filterable,desc='Primary contact address'`
// or `status,enum=inactive|active|banned,filterable`
func parseTagString(tag string) (parsedTag, error) {
	var res parsedTag
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return res, nil
	}

	tokens := tokenizeTag(tag)
	for i, tok := range tokens {
		if i == 0 && !strings.Contains(tok, "=") {
			// First positional token without '=' is the field name unless it's a known boolean flag
			if !isKnownFlag(tok) {
				res.Name = tok
				continue
			}
		}

		if !strings.Contains(tok, "=") {
			// Boolean flag
			switch tok {
			case "optional":
				res.Optional = true
			case "nullable":
				res.Nullable = true
			case "readonly":
				res.Readonly = true
			case "writeonly":
				res.Writeonly = true
			case "filterable":
				res.Filterable = true
			default:
				if res.Name == "" && i == 0 {
					res.Name = tok
				}
			}
			continue
		}

		eqIdx := strings.Index(tok, "=")
		key := strings.TrimSpace(tok[:eqIdx])
		val := strings.TrimSpace(tok[eqIdx+1:])

		// Unquote val if quoted with '...' or "..."
		if (strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'")) ||
			(strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"")) {
			if len(val) >= 2 {
				val = val[1 : len(val)-1]
			}
		}

		switch key {
		case "name":
			res.Name = val
		case "role":
			res.Role = val
		case "type":
			res.Type = val
		case "ref":
			res.Ref = val
		case "format":
			res.Format = val
		case "pattern":
			res.Pattern = val
		case "desc", "description":
			res.Description = val
		case "enum":
			res.Enum = strings.Split(val, "|")
		case "min":
			n, err := strconv.Atoi(val)
			if err != nil {
				return res, fmt.Errorf("invalid min value %q: %w", val, err)
			}
			res.Min = &n
		case "max":
			n, err := strconv.Atoi(val)
			if err != nil {
				return res, fmt.Errorf("invalid max value %q: %w", val, err)
			}
			res.Max = &n
		case "optional":
			res.Optional = val == "true" || val == "1"
		case "nullable":
			res.Nullable = val == "true" || val == "1"
		case "readonly":
			res.Readonly = val == "true" || val == "1"
		case "writeonly":
			res.Writeonly = val == "true" || val == "1"
		case "filterable":
			res.Filterable = val == "true" || val == "1"
		}
	}

	return res, nil
}

func isKnownFlag(s string) bool {
	switch s {
	case "optional", "nullable", "readonly", "writeonly", "filterable":
		return true
	default:
		return false
	}
}

// tokenizeTag splits tag string by comma, respecting quotes '...' and "..."
func tokenizeTag(tag string) []string {
	var tokens []string
	var current bytes.Buffer
	inSingleQuote := false
	inDoubleQuote := false

	for i := 0; i < len(tag); i++ {
		c := tag[i]
		switch c {
		case '\'':
			if !inDoubleQuote {
				inSingleQuote = !inSingleQuote
			}
			current.WriteByte(c)
		case '"':
			if !inSingleQuote {
				inDoubleQuote = !inDoubleQuote
			}
			current.WriteByte(c)
		case ',':
			if !inSingleQuote && !inDoubleQuote {
				tok := strings.TrimSpace(current.String())
				if tok != "" {
					tokens = append(tokens, tok)
				}
				current.Reset()
			} else {
				current.WriteByte(c)
			}
		default:
			current.WriteByte(c)
		}
	}

	tok := strings.TrimSpace(current.String())
	if tok != "" {
		tokens = append(tokens, tok)
	}

	return tokens
}

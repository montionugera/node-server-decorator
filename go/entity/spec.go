// Package entity declares entities in typed Go and emits the language-neutral EntitySpec IR
// (contracts/schemas/entity-spec.schema.json), byte-identical to the Node and Python entity
// packages.
package entity

import (
	"bytes"
	"encoding/json"
)

// SpecVersion is the EntitySpec IR version this package emits. It must equal the specVersion
// literal in node/packages/entity/src/restful.ts and
// python/packages/entity/src/server_decorator_entity/restful.py; byte parity with
// contracts/fixtures/entity-spec.valid-user.json enforces that.
const SpecVersion = "1.2.0"

// Every struct below declares its fields in ascending order of JSON name. encoding/json emits
// struct fields in declaration order and the IR requires sorted keys, so reordering a field
// silently breaks parity. TestStructKeysSorted guards this.

// Field is an entity field, a nested object field, a list item, or an action input.
type Field struct {
	Description string   `json:"description,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Fields      []Field  `json:"fields,omitempty"`
	Filterable  bool     `json:"filterable,omitempty"`
	Format      string   `json:"format,omitempty"`
	Item        *Field   `json:"item,omitempty"`
	Max         *int     `json:"max,omitempty"` // pointer: an explicit 0 must survive omitempty
	Min         *int     `json:"min,omitempty"` // pointer: an explicit 0 must survive omitempty
	Name        string   `json:"name"`
	Nullable    bool     `json:"nullable,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Pattern     string   `json:"pattern,omitempty"`
	Readonly    bool     `json:"readonly,omitempty"`
	Ref         string   `json:"ref,omitempty"`
	Role        string   `json:"role,omitempty"`
	Type        string   `json:"type"`
	Writeonly   bool     `json:"writeonly,omitempty"`
}

// Action is a named entity action, optionally a state transition.
type Action struct {
	Description   string  `json:"description,omitempty"`
	From          string  `json:"from,omitempty"`
	Input         []Field `json:"input,omitempty"`
	Name          string  `json:"name"`
	StateField    string  `json:"stateField,omitempty"`
	To            string  `json:"to,omitempty"`
	Transactional *bool   `json:"transactional,omitempty"` // schema const false; nil means absent
}

// Scheme is one security scheme.
type Scheme struct {
	BearerFormat string `json:"bearerFormat,omitempty"`
	In           string `json:"in,omitempty"`
	Name         string `json:"name"`
	ParamName    string `json:"paramName,omitempty"`
	Scheme       string `json:"scheme,omitempty"`
	Type         string `json:"type"`
}

// Security maps ops and actions to required scopes.
type Security struct {
	Actions map[string][]string `json:"actions,omitempty"`
	Ops     map[string][]string `json:"ops,omitempty"`
	Schemes []Scheme            `json:"schemes"`
}

// Spec is the EntitySpec IR document.
type Spec struct {
	Actions     []Action  `json:"actions,omitempty"`
	Description string    `json:"description,omitempty"`
	Entity      string    `json:"entity"`
	Fields      []Field   `json:"fields"`
	Ops         []string  `json:"ops"`
	Pagination  string    `json:"pagination"`
	Path        string    `json:"path"`
	Security    *Security `json:"security,omitempty"`
	SpecVersion string    `json:"specVersion"`
	Tags        []string  `json:"tags,omitempty"`
	Transports  []string  `json:"transports"`
}

// MarshalCanonical returns the canonical IR bytes: sorted keys, compact separators, no HTML
// escaping, no trailing newline — byte-identical to Node's entitySpecCanonical and Python's
// equivalent.
func MarshalCanonical(s Spec) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // JSON.stringify and json.dumps do not escape <, >, &
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	out := bytes.TrimRight(buf.Bytes(), "\n") // Encode appends a newline; Marshal does not
	return unescapeLineSeparators(out), nil
}

// unescapeLineSeparators undoes encoding/json's unconditional \u2028 / \u2029 escaping, which
// SetEscapeHTML(false) does not turn off; JSON.stringify and json.dumps(ensure_ascii=False) emit
// the raw characters. Escapes are consumed pairwise, so an escaped backslash followed by "u2028"
// is left alone.
func unescapeLineSeparators(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		switch {
		case b[i] != '\\' || i+1 == len(b):
			out = append(out, b[i])
		case bytes.HasPrefix(b[i:], []byte(`\u2028`)):
			out, i = append(out, "\u2028"...), i+5
		case bytes.HasPrefix(b[i:], []byte(`\u2029`)):
			out, i = append(out, "\u2029"...), i+5
		default:
			out, i = append(out, b[i], b[i+1]), i+1
		}
	}
	return out
}

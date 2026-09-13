# I-006 Go lane — `entity` IR producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Go `entity` package that emits the byte-identical EntitySpec IR already produced by the Node and Python `entity` packages, verified against `contracts/fixtures/entity-spec.valid-user.json`, and wire it into lockstep versioning, parity scripts, and CI.

**Architecture:** A root `go.mod` (`module github.com/montionugera/node-server-decorator/v2`) with all Go code under `go/`. `go/entity` holds typed wire structs whose field order produces sorted JSON keys, a builder API as the declaration surface, and a canonical marshaller. Go joins at the IR boundary: its bytes are compared against the same contract fixture as Node and Python.

**Tech Stack:** Go 1.22 standard library only (`encoding/json`, `reflect`, `flag`); bash scripts; GitHub Actions (`actions/setup-go@v5`).

**Spec:** `.claude/idea_backlog/I-006-go-lane-third-language-via-go-generate-e/spec.md` (approved 2026-09-13). Prototype notes: `research.md` in the same folder.

## Global Constraints

- Module path is exactly `github.com/montionugera/node-server-decorator/v2`; `go.mod` declares `go 1.22`.
- `go/entity` imports the standard library only — no third-party module, so no `go.sum` exists.
- `go/entity` never imports `node/`, `python/`, or any future `go/gen*` package (layering: `entity` → `gen-*` → adapters).
- `SpecVersion` is `"1.2.0"`, equal to `node/packages/entity/src/restful.ts:36` and `python/packages/entity/src/server_decorator_entity/restful.py:89`.
- **No change to `contracts/`** — no new fixture, no `VERSION` bump. The escape golden lives in `go/entity/testdata/`.
- `go/entity/version.go` holds the same version as `node/packages/core/package.json` at the time of implementation (read it; do not hardcode from this plan).
- Go commands are scoped to `go/`: `gofmt -l go`, `go vet ./go/...`, `go test ./go/...` — never a root `./...` (it walks `node/`, `python/`, `interop/`).
- One commit per task; **never `git commit --amend`**.
- Every canonical JSON artifact has **no trailing newline**.

## Before Task 1 (release workflow — not part of the implementation)

This plan sits in the idea backlog. Implementation needs the idea refined and claimed so the work
happens in its own feature worktree (the `_release` worktree is for backlog metadata only):
`psrw refine I-006` → `psrw claim F-NNN` → run every task below inside the claimed worktree.
**Both steps need the user's explicit go-ahead** — they are not automatic.

In the claimed worktree, before Task 1, install deps once (needed by Tasks 4, 5, 7):
`cd node && pnpm install --frozen-lockfile` and `cd python && uv sync --all-packages`.

## Spec deviations (decided while planning — reviewers, don't re-flag)

1. **The consumer-facing generator is a library function, not a CLI.** A prebuilt command cannot
   import a consumer's compiled specs, so the reusable surface is `entity.WriteFiles(dir, specs...)`
   in a new `go/entity/generate.go` (a fourth library file; the spec said three).
   `go/cmd/gen-entity-spec` remains, as this repo's go:generate target and the ~15-line `main`
   a consumer copies (documented in `go/README.md`).
2. **The tag push is the last step of the publish job**, after PyPI publish, not immediately after
   the bump commit. It is still after the bump commit (as the spec requires), and a tag then exists
   only for a version that fully published.
3. **Builder covers every schema key**, not only those in the `valid-user` fixture: `Ref`, `Pattern`,
   and `NonTransactional()` are added beyond the research surface.

## Known edges (documented, not fixed)

- Node emits `"tags":[]` for an explicit empty list and passes empty `security.ops`/`actions` maps
  through; Go's `omitempty` drops them. Both forms are schema-valid and no fixture exercises them.
- **Filed, out of scope:** `ci-node.yml`'s publish job triggers only on `node/**` and `contracts/**`,
  so a Python-only merge already neither publishes nor tags — and a Go-only merge will not either.
- **Filed, out of scope:** no CI step ties `specVersion` literals to `contracts/VERSION` (spec, "The
  contract-version site Go actually mirrors").

## File map

| File | Task | Responsibility |
|---|---|---|
| `go.mod` | 1 | Root module declaration |
| `go/entity/spec.go` | 1 | Wire types + `MarshalCanonical` — the only code that knows the byte format |
| `go/entity/spec_test.go` | 1 | Key-order, zero-`min`, HTML-escape guards |
| `go/entity/testdata/html-escape.json` | 1 | Golden bytes from `JSON.stringify` / `json.dumps` |
| `go/entity/build.go` | 2 | Builder + `FieldOpt` markers — the declaration surface |
| `go/internal/example/user.go` | 2 (go:generate line in 3) | `UserSpec` mirroring the contract fixture |
| `go/internal/example/user_test.go` | 2 (drift test in 3) | Byte parity + drift gate |
| `go/entity/generate.go` | 3 | `FileName`, `WriteFiles` |
| `go/cmd/gen-entity-spec/main.go` | 3 | Reference go:generate command |
| `go/internal/example/testdata/entity-spec.users.json` | 3 | Committed generator output |
| `go/internal/example/emitfixture/main.go` | 4 | Prints User IR to stdout for the parity script |
| `scripts/check-entity-parity.sh` | 4 | + Go producer |
| `go/entity/version.go` | 5 | `const Version` |
| `scripts/bump-version.sh`, `scripts/check-versions.sh` | 5 | + Go version |
| `.github/workflows/ci-go.yml` | 6 | New Go lane |
| `.github/workflows/ci-contracts.yml` | 6 | Go path triggers + `setup-go` |
| `.github/workflows/ci-node.yml` | 6 | Allowlist + tag push |
| `go/README.md`, `CLAUDE.md` | 7 | Consumption docs, command table |

---

### Task 1: Root module, wire types, canonical marshaller

Covers spec acceptance items 2 (HTML escape), 3 (zero `min`), 4 (key order).

**Files:**
- Create: `go.mod`
- Create: `go/entity/spec.go`
- Create: `go/entity/testdata/html-escape.json`
- Test: `go/entity/spec_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `const SpecVersion = "1.2.0"`; types `Field`, `Action`, `Scheme`, `Security`, `Spec` (exact fields below); `func MarshalCanonical(s Spec) ([]byte, error)`.

- [ ] **Step 1: Create the module and the golden file**

`go.mod`:

```
module github.com/montionugera/node-server-decorator/v2

go 1.22
```

`go/entity/testdata/html-escape.json` — generate with `JSON.stringify` (keys already in sorted order) so there is **no trailing newline**. It covers HTML characters, raw U+2028/U+2029 (which Go's encoder escapes even with `SetEscapeHTML(false)`), and a literal backslash followed by `u2028` that must stay escaped:

```bash
mkdir -p go/entity/testdata
node -e 'process.stdout.write(JSON.stringify({description:"a <b> & c \u2028 \u2029",entity:"Escape",fields:[{description:"x < y && y > z \\u2028",name:"id",type:"str"}],ops:["get"],pagination:"offset",path:"escapes",specVersion:"1.2.0",transports:["rest"]}))' > go/entity/testdata/html-escape.json
python3 -c 'b=open("go/entity/testdata/html-escape.json","rb").read();print(b.count(b"\xe2\x80\xa8"),b.count(b"\xe2\x80\xa9"),b.count(b"\\\\u2028"))'   # must print: 1 1 1
```

Prove the golden matches both other languages (both commands must print `OK`):

```bash
S=$(cat go/entity/testdata/html-escape.json)
node -e 'const s=(v)=>Array.isArray(v)?v.map(s):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,s(v[k])])):v;process.stdout.write(JSON.stringify(s(JSON.parse(process.argv[1]))))' "$S" | cmp - go/entity/testdata/html-escape.json && echo OK
python3 -c 'import json,sys;sys.stdout.write(json.dumps(json.loads(sys.argv[1]),sort_keys=True,separators=(",",":"),ensure_ascii=False))' "$S" | cmp - go/entity/testdata/html-escape.json && echo OK
```

- [ ] **Step 2: Write the failing tests** — `go/entity/spec_test.go`:

```go
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./go/entity`
Expected: FAIL — build errors `undefined: Field`, `undefined: MarshalCanonical`, `undefined: SpecVersion`.

- [ ] **Step 4: Write the implementation** — `go/entity/spec.go`:

```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./go/entity -v 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for `TestStructKeysSorted`, `TestMarshalCanonicalKeepsZeroMin`, `TestMarshalCanonicalDoesNotEscapeHTML`; `ok`.

- [ ] **Step 6: Hygiene and commit**

```bash
test -z "$(gofmt -l go)" && go vet ./go/... && echo HYGIENE-OK
git add go.mod go/entity/spec.go go/entity/spec_test.go go/entity/testdata/html-escape.json
git commit -m "feat(go): root module + EntitySpec wire types and canonical marshaller"
```

- [ ] **Step 7: Prove each guard has teeth** (after the Step 6 commit; restore after each with `git checkout -- go/entity/spec.go`)

1. Swap the `Max` and `Min` lines in `Field` → `go test ./go/entity` fails with `Field JSON keys not declared in sorted order`.
2. Delete the `enc.SetEscapeHTML(false)` line → fails with `HTML-escape divergence`.
2b. Change `return unescapeLineSeparators(out), nil` to `return out, nil` → fails with `HTML-escape divergence` (U+2028/U+2029 come out escaped).
3. Change `Min *int` to `Min int` and `Min: &zero` to `Min: zero` in the test → fails with `"min":0 was dropped`. Restore the test with `git checkout -- go/entity/spec_test.go`.

Then: `go test ./go/entity` → `ok`.

- [ ] **Step 8: Phase gate** (rule 7): verify (Steps 5–7 output) → independent review (`code-reviewer`, `model: sonnet`) of this task's diff → `/simplify` → re-run `go test ./go/...`.

---

### Task 2: Builder API + User example + byte parity

Covers spec acceptance item 1.

**Files:**
- Create: `go/entity/build.go`
- Create: `go/internal/example/user.go`
- Test: `go/internal/example/user_test.go`

**Interfaces:**
- Consumes: Task 1's `Spec`, `Field`, `Action`, `Scheme`, `Security`, `SpecVersion`, `MarshalCanonical`.
- Produces:
  - `func New(entity, path string) *Builder`; `*Builder` methods `Desc(string)`, `Tags(...string)`, `Transports(...string)`, `Ops(...string)`, `Pagination(string)`, `Fields(...Field)`, `Actions(...*ActionBuilder)`, `Secure(Security)` (all return `*Builder`), `Build() Spec`.
  - `func Act(name string) *ActionBuilder`; methods `Desc(string)`, `In(...Field)`, `Transition(stateField, from, to string)`, `NonTransactional()` (all return `*ActionBuilder`).
  - `type FieldOpt func(*Field)`; values `ID`, `Filterable`, `Nullable`, `Optional`, `Readonly`, `Writeonly`; funcs `Desc(string)`, `Format(string)`, `Pattern(string)`, `Min(int)`, `Max(int)`, `Values(...string)`, `Of(Field)`, `Sub(...Field)` returning `FieldOpt`.
  - Field constructors `Str`, `Int`, `Float`, `Bool`, `DateTime`, `Enum`, `List`, `Obj` — `(name string, opts ...FieldOpt) Field`; `Ref(name, target string, opts ...FieldOpt) Field`.
  - `var example.UserSpec entity.Spec` in package `github.com/montionugera/node-server-decorator/v2/go/internal/example`.

- [ ] **Step 1: Write the failing test** — `go/internal/example/user_test.go`:

```go
package example

import (
	"bytes"
	"os"
	"testing"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
)

func TestUserSpecMatchesContractFixture(t *testing.T) {
	want, err := os.ReadFile("../../../contracts/fixtures/entity-spec.valid-user.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.MarshalCanonical(UserSpec)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("Go IR != contract fixture\n got: %s\nwant: %s", got, want)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./go/internal/example`
Expected: FAIL — `undefined: UserSpec`.

- [ ] **Step 3: Write the builder** — `go/entity/build.go`:

```go
package entity

// Builder assembles a Spec. New applies the same defaults as Node's @Restful and Python's
// @restful: transports [rest], all five ops, offset pagination.
type Builder struct{ s Spec }

// New starts a spec for entity served at path.
func New(entity, path string) *Builder {
	return &Builder{s: Spec{
		Entity:      entity,
		Ops:         []string{"list", "get", "create", "update", "delete"},
		Pagination:  "offset",
		Path:        path,
		SpecVersion: SpecVersion,
		Transports:  []string{"rest"},
	}}
}

func (b *Builder) Desc(d string) *Builder           { b.s.Description = d; return b }
func (b *Builder) Tags(tags ...string) *Builder     { b.s.Tags = tags; return b }
func (b *Builder) Transports(ts ...string) *Builder { b.s.Transports = ts; return b }
func (b *Builder) Ops(ops ...string) *Builder       { b.s.Ops = ops; return b }
func (b *Builder) Pagination(p string) *Builder     { b.s.Pagination = p; return b }
func (b *Builder) Fields(fs ...Field) *Builder      { b.s.Fields = fs; return b }
func (b *Builder) Secure(sec Security) *Builder     { b.s.Security = &sec; return b }
func (b *Builder) Build() Spec                      { return b.s }
func (b *Builder) Actions(acts ...*ActionBuilder) *Builder {
	b.s.Actions = make([]Action, len(acts))
	for i, a := range acts {
		b.s.Actions[i] = a.a
	}
	return b
}

// ActionBuilder assembles one Action.
type ActionBuilder struct{ a Action }

// Act starts an action named name.
func Act(name string) *ActionBuilder { return &ActionBuilder{a: Action{Name: name}} }

func (b *ActionBuilder) Desc(d string) *ActionBuilder  { b.a.Description = d; return b }
func (b *ActionBuilder) In(fs ...Field) *ActionBuilder { b.a.Input = fs; return b }
func (b *ActionBuilder) Transition(stateField, from, to string) *ActionBuilder {
	b.a.StateField, b.a.From, b.a.To = stateField, from, to
	return b
}

// NonTransactional emits "transactional":false, the only value the schema allows.
func (b *ActionBuilder) NonTransactional() *ActionBuilder {
	f := false
	b.a.Transactional = &f
	return b
}

// FieldOpt sets one marker on a Field. Markers are package-level values rather than fluent
// methods because Go forbids a method and a struct field sharing a name (Field.Min vs .Min()).
type FieldOpt func(*Field)

// Flag markers.
var (
	ID         FieldOpt = func(f *Field) { f.Role = "id" }
	Filterable FieldOpt = func(f *Field) { f.Filterable = true }
	Nullable   FieldOpt = func(f *Field) { f.Nullable = true }
	Optional   FieldOpt = func(f *Field) { f.Optional = true }
	Readonly   FieldOpt = func(f *Field) { f.Readonly = true }
	Writeonly  FieldOpt = func(f *Field) { f.Writeonly = true }
)

func Desc(d string) FieldOpt       { return func(f *Field) { f.Description = d } }
func Format(fmt string) FieldOpt   { return func(f *Field) { f.Format = fmt } }
func Pattern(p string) FieldOpt    { return func(f *Field) { f.Pattern = p } }
func Min(n int) FieldOpt           { return func(f *Field) { f.Min = &n } }
func Max(n int) FieldOpt           { return func(f *Field) { f.Max = &n } }
func Values(vs ...string) FieldOpt { return func(f *Field) { f.Enum = vs } }
func Of(item Field) FieldOpt       { return func(f *Field) { f.Item = &item } }
func Sub(fields ...Field) FieldOpt { return func(f *Field) { f.Fields = fields } }

func field(name, typ string, opts []FieldOpt) Field {
	f := Field{Name: name, Type: typ}
	for _, o := range opts {
		o(&f)
	}
	return f
}

func Str(name string, opts ...FieldOpt) Field      { return field(name, "str", opts) }
func Int(name string, opts ...FieldOpt) Field      { return field(name, "int", opts) }
func Float(name string, opts ...FieldOpt) Field    { return field(name, "float", opts) }
func Bool(name string, opts ...FieldOpt) Field     { return field(name, "bool", opts) }
func DateTime(name string, opts ...FieldOpt) Field { return field(name, "datetime", opts) }
func Enum(name string, opts ...FieldOpt) Field     { return field(name, "enum", opts) }
func List(name string, opts ...FieldOpt) Field     { return field(name, "list", opts) }
func Obj(name string, opts ...FieldOpt) Field      { return field(name, "obj", opts) }

// Ref declares a field referencing the entity named target.
func Ref(name, target string, opts ...FieldOpt) Field {
	f := field(name, "ref", opts)
	f.Ref = target
	return f
}
```

- [ ] **Step 4: Write the example** — `go/internal/example/user.go` (Task 3 adds a `//go:generate` line; do not add it now):

```go
// Package example declares the User entity mirroring
// contracts/fixtures/entity-spec.valid-user.json. It exists only to feed the parity tests.
package example

import e "github.com/montionugera/node-server-decorator/v2/go/entity"

// UserSpec must marshal byte-identical to contracts/fixtures/entity-spec.valid-user.json.
var UserSpec = e.New("User", "users").
	Desc("A registered user account").
	Tags("identity").
	Transports("rest", "rpc", "sse", "ws").
	Ops("list", "get", "create", "update", "delete").
	Pagination("offset").
	Fields(
		e.Str("id", e.ID, e.Readonly),
		e.Str("email", e.Desc("Primary contact address"), e.Format("email"), e.Filterable),
		e.Str("name", e.Min(2), e.Max(80)),
		e.Enum("status", e.Values("inactive", "active", "banned"), e.Filterable),
		e.Int("loginCount", e.Min(0), e.Readonly),
		e.List("tags", e.Of(e.Str("tags"))),
		e.Obj("profile", e.Sub(e.Str("bio", e.Max(500), e.Optional)), e.Optional),
		e.DateTime("birthday", e.Nullable, e.Optional),
		e.Float("score", e.Min(0), e.Optional),
		e.Bool("active", e.Optional),
		e.Str("secretNote", e.Max(100), e.Writeonly, e.Optional),
	).
	Actions(
		e.Act("activate").
			Desc("Move a dormant account back to active").
			Transition("status", "inactive", "active").
			In(e.Str("reason", e.Max(200), e.Optional)),
		e.Act("ping"),
	).
	Secure(e.Security{
		Schemes: []e.Scheme{{Name: "bearerAuth", Type: "http", Scheme: "bearer", BearerFormat: "JWT"}},
		Ops:     map[string][]string{"create": {"user:write"}, "update": {"user:write"}, "delete": {"user:admin"}},
		Actions: map[string][]string{"activate": {"user:admin"}},
	}).
	Build()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./go/...`
Expected: `ok` for `go/entity` and `go/internal/example`.

Byte-level cross-check (must print `OK`):
`go test ./go/internal/example -run TestUserSpecMatchesContractFixture -v 2>&1 | grep -q -- '--- PASS' && echo OK`

- [ ] **Step 6: Commit**

```bash
test -z "$(gofmt -l go)" && go vet ./go/... && echo HYGIENE-OK
git add go/entity/build.go go/internal/example/user.go go/internal/example/user_test.go
git commit -m "feat(go): entity builder API + User example, byte-identical to contract fixture"
```

- [ ] **Step 7: Phase gate** (rule 7): verify → independent review (`code-reviewer`, `model: sonnet`) — ask it specifically to diff the builder surface against every key in `contracts/schemas/entity-spec.schema.json` → `/simplify` → re-run `go test ./go/...`.

---

### Task 3: Generator + `go generate` drift gate

Covers spec acceptance item 5.

**Files:**
- Create: `go/entity/generate.go`
- Create: `go/cmd/gen-entity-spec/main.go`
- Create (generated, committed): `go/internal/example/testdata/entity-spec.users.json`
- Modify: `go/internal/example/user.go` (add the `//go:generate` line)
- Test: `go/internal/example/user_test.go` (append `TestGeneratedFileIsCurrent`)

**Interfaces:**
- Consumes: Task 1's `MarshalCanonical`, `Spec`; Task 2's `example.UserSpec`.
- Produces: `func FileName(s Spec) string` (returns `entity-spec.<path>.json`); `func WriteFiles(dir string, specs ...Spec) error`.

- [ ] **Step 1: Write the failing test** — append to `go/internal/example/user_test.go` (imports are already present):

```go
func TestGeneratedFileIsCurrent(t *testing.T) {
	path := "testdata/" + e.FileName(UserSpec)
	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s missing — run go generate ./go/...: %v", path, err)
	}
	// Regenerate through the same WriteFiles path go:generate uses, so a generator bug is caught too.
	dir := t.TempDir()
	if err := e.WriteFiles(dir, UserSpec); err != nil {
		t.Fatal(err)
	}
	fresh, err := os.ReadFile(dir + "/" + e.FileName(UserSpec))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(committed, fresh) {
		t.Fatalf("%s is stale — run go generate ./go/...", path)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./go/internal/example`
Expected: FAIL — build errors `undefined: e.FileName`, `undefined: e.WriteFiles`.

- [ ] **Step 3: Write the library function** — `go/entity/generate.go`:

```go
package entity

import (
	"os"
	"path/filepath"
)

// FileName is the artifact name for s: entity-spec.<path>.json.
func FileName(s Spec) string { return "entity-spec." + s.Path + ".json" }

// WriteFiles writes each spec's canonical IR to dir/FileName(spec). A consumer's go:generate
// target is a small main that calls this with its declared specs (see go/cmd/gen-entity-spec).
func WriteFiles(dir string, specs ...Spec) error {
	for _, s := range specs {
		b, err := MarshalCanonical(s)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, FileName(s)), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: Write the reference command** — `go/cmd/gen-entity-spec/main.go`:

```go
// Command gen-entity-spec writes this repo's example entity specs as IR JSON. It is the
// reference go:generate target: a consumer copies it, swapping in their own specs.
package main

import (
	"flag"
	"log"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func main() {
	out := flag.String("out", ".", "directory to write entity-spec.<path>.json files into")
	flag.Parse()
	if err := e.WriteFiles(*out, example.UserSpec); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 5: Add the go:generate directive** — in `go/internal/example/user.go`, insert this line between the `import` line and the blank line that follows it, preceded by one new blank line (result: `import …`, blank, directive, blank, `// UserSpec …` — exactly one blank line on each side, or `gofmt -l go` flags the file):

```go
//go:generate go run ../../cmd/gen-entity-spec -out testdata
```

- [ ] **Step 6: Confirm the drift gate fails before generating**

Run: `go test ./go/internal/example`
Expected: FAIL — `testdata/entity-spec.users.json missing — run go generate ./go/...`

- [ ] **Step 7: Generate and verify**

```bash
mkdir -p go/internal/example/testdata
go generate ./go/...
cmp go/internal/example/testdata/entity-spec.users.json contracts/fixtures/entity-spec.valid-user.json && echo "generated == fixture"
go test ./go/...
```

Expected: `generated == fixture`; `ok` for both test packages.

- [ ] **Step 8: Commit, then prove the gate has teeth**

```bash
test -z "$(gofmt -l go)" && go vet ./go/... && echo HYGIENE-OK
git add go/entity/generate.go go/cmd/gen-entity-spec/main.go go/internal/example/user.go go/internal/example/user_test.go go/internal/example/testdata/entity-spec.users.json
git commit -m "feat(go): WriteFiles + gen-entity-spec go:generate target with drift gate"
printf ' ' >> go/internal/example/testdata/entity-spec.users.json
go test ./go/internal/example 2>&1 | grep 'is stale — run go generate'   # must print the line
git checkout -- go/internal/example/testdata/entity-spec.users.json
go test ./go/...                                                          # ok again
```

- [ ] **Step 9: Phase gate** (rule 7): verify → independent review (`code-reviewer`, `model: sonnet`) → `/simplify` → re-run `go test ./go/...`.

---

### Task 4: Three-language parity script

Covers spec acceptance item 7.

**Files:**
- Create: `go/internal/example/emitfixture/main.go`
- Modify: `scripts/check-entity-parity.sh` (whole file shown)

**Interfaces:**
- Consumes: Task 1's `MarshalCanonical`; Task 2's `example.UserSpec`.
- Produces: `go run ./go/internal/example/emitfixture` prints the User IR to stdout, no trailing newline.

- [ ] **Step 1: Extend the script first, so it fails** — replace `scripts/check-entity-parity.sh` with:

```bash
#!/usr/bin/env bash
# Assert TS, Python and Go entity declarations emit byte-identical IR, equal to the contract fixture.
set -euo pipefail
cd "$(dirname "$0")/.."

fixture=contracts/fixtures/entity-spec.valid-user.json
ts_out=$(cd node/packages/entity && pnpm exec tsx scripts/emit-fixture.ts)
py_out=$(cd python && uv run --package server-decorator-entity python packages/entity/scripts/emit_fixture.py)
go_out=$(go run ./go/internal/example/emitfixture)
expected=$(cat "$fixture")

[ "$ts_out" = "$expected" ] || { echo "FAIL: TS IR != $fixture" >&2; diff <(echo "$ts_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$py_out" = "$expected" ] || { echo "FAIL: PY IR != $fixture" >&2; diff <(echo "$py_out") <(echo "$expected") >&2 || true; exit 1; }
[ "$go_out" = "$expected" ] || { echo "FAIL: GO IR != $fixture" >&2; diff <(echo "$go_out") <(echo "$expected") >&2 || true; exit 1; }
echo "OK: entity-spec parity (TS == PY == GO == contract fixture)"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash scripts/check-entity-parity.sh; echo "exit=$?"`
Expected: a `go run` error because `go/internal/example/emitfixture` does not exist yet; `exit=1`.

- [ ] **Step 3: Write the emitter** — `go/internal/example/emitfixture/main.go`:

```go
// Command emitfixture prints the User IR to stdout for scripts/check-entity-parity.sh — the Go
// twin of node/packages/entity/scripts/emit-fixture.ts and
// python/packages/entity/scripts/emit_fixture.py.
package main

import (
	"log"
	"os"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

func main() {
	b, err := e.MarshalCanonical(example.UserSpec)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stdout.Write(b); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash scripts/check-entity-parity.sh; echo "exit=$?"`
Expected: `OK: entity-spec parity (TS == PY == GO == contract fixture)`; `exit=0`.

- [ ] **Step 5: Commit**

```bash
test -z "$(gofmt -l go)" && go vet ./go/... && echo HYGIENE-OK
git add go/internal/example/emitfixture/main.go scripts/check-entity-parity.sh
git commit -m "feat(go): Go producer in check-entity-parity.sh"
```

- [ ] **Step 6: Phase gate** — shared with Task 5 (both small `scripts/` diffs); run it at the end of Task 5.

---

### Task 5: Version lockstep

Covers spec acceptance item 8.

**Files:**
- Create: `go/entity/version.go`
- Modify: `scripts/check-versions.sh` (header comment + new block before the `count=` line)
- Modify: `scripts/bump-version.sh` (new block after the `_version.py` loop, before `uv lock`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `const entity.Version string`, rewritten by `bump-version.sh`, asserted by `check-versions.sh`.

- [ ] **Step 1: Make the gate collect Go first, so it fails** — in `scripts/check-versions.sh`, change line 2 to:

```bash
# Assert every published package (Node + Python + Go) is at the same version (Decision #2, ADR 0007).
```

and insert directly before the `count=$(printf ...` line:

```bash
# go/entity/version.go is the Go module's runtime version constant (I-006).
go_v=$(grep -oE '^const Version = "[^"]+"' go/entity/version.go | grep -oE '"[^"]+"' | tr -d '"') \
  || { echo "FAIL: no 'const Version = \"x.y.z\"' in go/entity/version.go" >&2; exit 1; }
versions+="go/entity/version.go=$go_v\n"
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash scripts/check-versions.sh; echo "exit=$?"`
Expected: a `grep: go/entity/version.go: No such file or directory` line, then `FAIL: no 'const Version = "x.y.z"' in go/entity/version.go`; `exit=1`.

- [ ] **Step 3: Create the constant** with the current lockstep version:

```bash
v=$(node -p "require('./node/packages/core/package.json').version")
cat > go/entity/version.go <<EOF
package entity

// Version is this module's release version, in lockstep with every Node and Python package
// (Decision #2). scripts/bump-version.sh rewrites it; scripts/check-versions.sh asserts it.
const Version = "$v"
EOF
test -z "$(gofmt -l go)" && echo GOFMT-OK
```

- [ ] **Step 4: Run to verify it passes, and fails on a hand edit**

```bash
bash scripts/check-versions.sh; echo "exit=$?"                 # OK: all packages at <version>; exit=0
sed -i.bak 's/^const Version = .*/const Version = "9.9.9"/' go/entity/version.go && rm go/entity/version.go.bak
bash scripts/check-versions.sh; echo "exit=$?"                 # FAIL: package versions diverge ... go/entity/version.go=9.9.9; exit=1
```

Restore the real value by re-running Step 3, then `bash scripts/check-versions.sh` → `OK`.

- [ ] **Step 5: Teach the bump script** — in `scripts/bump-version.sh`, insert after the `_version.py` `for` loop (ends `done` before the `# uv.lock pins` comment):

```bash
# Mirror into the Go module's runtime version constant (I-006) — Go consumers read it, and
# check-versions.sh asserts it.
go_version_file=go/entity/version.go
sed -i.bak -E "s/^const Version = \"[^\"]+\"$/const Version = \"$new_version\"/" "$go_version_file" \
  && rm "$go_version_file.bak"
```

- [ ] **Step 6: Commit, then prove the bump rewrites Go**

```bash
test -z "$(gofmt -l go)" && go vet ./go/... && echo HYGIENE-OK
git add go/entity/version.go scripts/check-versions.sh scripts/bump-version.sh
git commit -m "feat(go): go/entity/version.go in lockstep bump + check"
bash scripts/bump-version.sh patch                  # ends with "OK: all packages at <v+1>" and "Bumped all packages"
git diff --name-only | grep -x go/entity/version.go # must print the path
git diff --name-only | xargs git restore --         # revert the trial bump (only bump-touched files are dirty)
git status --short                                   # must print nothing
```

- [ ] **Step 7: Phase gate for Tasks 4 + 5** (rule 7): verify (Task 4 Step 4, Task 5 Steps 4 and 6) → independent review (`code-reviewer`, `model: sonnet`) of both commits → `/simplify` → re-run `bash scripts/check-entity-parity.sh && bash scripts/check-versions.sh`.

---

### Task 6: CI wiring — three workflow files

Covers spec acceptance item 10. **R1 (CI config, adds a remote tag write) — state this in the commit body and the PR.**

**Files:**
- Create: `.github/workflows/ci-go.yml`
- Modify: `.github/workflows/ci-contracts.yml:13-26` (paths) and `:58-70` (`entity-parity` job)
- Modify: `.github/workflows/ci-node.yml:106` (allowlist) and end of the `publish` job (tag step)

**Interfaces:**
- Consumes: `go test ./go/...`, `gofmt -l go`, `go vet ./go/...` (Tasks 1–3); `scripts/check-entity-parity.sh` (Task 4); `scripts/check-versions.sh`, `go/entity/version.go` (Task 5).
- Produces: nothing code-level.

- [ ] **Step 1: Write a failing structural check** — save as a local helper (not committed) and run it:

```bash
cat > "$TMPDIR/ci-go-check.sh" <<'CHK'
set -e
cd "$(git rev-parse --show-toplevel)"
ruby -ryaml -e 'ARGV.each { |f| YAML.load_file(f) }' .github/workflows/ci-go.yml .github/workflows/ci-contracts.yml .github/workflows/ci-node.yml
grep -q "go test ./go/..." .github/workflows/ci-go.yml
grep -q 'gofmt -l go' .github/workflows/ci-go.yml
[ "$(grep -c "'go/\*\*'" .github/workflows/ci-contracts.yml)" = 2 ]
[ "$(grep -c "'go.mod'" .github/workflows/ci-contracts.yml)" = 2 ]
grep -q 'actions/setup-go@v5' .github/workflows/ci-contracts.yml
grep -q 'go/entity/version.go' .github/workflows/ci-node.yml
grep -q 'git push origin "\$tag"' .github/workflows/ci-node.yml
echo CI-WIRING-OK
CHK
bash "$TMPDIR/ci-go-check.sh"; echo "exit=$?"
```

Expected: `No such file or directory` for `ci-go.yml`; `exit=1`.

- [ ] **Step 2: Create `.github/workflows/ci-go.yml`**

```yaml
name: CI - Go

on:
  pull_request:
    paths: ['go/**', 'go.mod', 'go.sum', 'contracts/**', '.github/workflows/ci-go.yml']
  push:
    branches: [main]
    paths: ['go/**', 'go.mod', 'go.sum', 'contracts/**', '.github/workflows/ci-go.yml']

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # go/entity is stdlib-only, so there is no go.sum to key a module cache on.
      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod, cache: false }
      - name: gofmt
        run: test -z "$(gofmt -l go)" || { gofmt -l go; exit 1; }
      # Scoped to go/: a root ./... would walk node/, python/ and interop/.
      - run: go vet ./go/...
      # Byte parity, HTML-escape, zero-min, key-order guards and the go:generate drift gate.
      - run: go test ./go/...
```

- [ ] **Step 3: Edit `.github/workflows/ci-contracts.yml`**

In **both** the `pull_request.paths` and `push.paths` lists, add after `- 'scripts/**'`:

```yaml
      - 'go/**'
      - 'go.mod'
      - 'go.sum'
```

In the `entity-parity` job, insert after `- uses: astral-sh/setup-uv@v5`:

```yaml
      # check-entity-parity.sh runs the Go producer too (I-006).
      - uses: actions/setup-go@v5
        with: { go-version-file: go.mod, cache: false }
```

- [ ] **Step 4: Edit `.github/workflows/ci-node.yml`**

In the `Commit version bump` step, replace the `git add` line with:

```yaml
          git add node/packages/*/package.json node/pnpm-lock.yaml python/packages/*/pyproject.toml python/packages/*/src/*/_version.py python/uv.lock go/entity/version.go
```

Append as the **last step** of the `publish` job (after `Publish Python to PyPI`):

```yaml
      # Go resolves module versions only from vX.Y.Z tags (I-006); this also gives Node and
      # Python releases the single tag ADR 0002 assumes. Last step, so a tag marks only a
      # fully published version; skipped when the tag already exists (idempotent re-runs).
      - name: Tag release
        run: |
          tag="v$(node -p "require('./node/packages/core/package.json').version")"
          if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
            echo "Tag $tag already exists on origin; skipping."
          else
            git tag "$tag"
            git push origin "$tag"
          fi
```

- [ ] **Step 5: Run the structural check to verify it passes**

Run: `bash "$TMPDIR/ci-go-check.sh"; echo "exit=$?"`
Expected: `CI-WIRING-OK`; `exit=0`.

Also run locally exactly what the new jobs run: `test -z "$(gofmt -l go)" && go vet ./go/... && go test ./go/... && bash scripts/check-entity-parity.sh && bash scripts/check-versions.sh` → all pass.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci-go.yml .github/workflows/ci-contracts.yml .github/workflows/ci-node.yml
git commit -m "ci(go): ci-go lane, Go triggers in ci-contracts, tag push + version.go in publish

R1: the publish job now pushes a vX.Y.Z tag to origin after a successful publish."
```

The workflows themselves are exercised when the release PR opens: `CI - Go` and `CI - Contracts` must both run and pass on that PR. Record the run URLs in the PR description.

- [ ] **Step 7: Phase gate** (rule 7, full gate — CI/deploy surface): verify (Step 5) → independent review (`code-reviewer`, default model) focused on: tag step failure modes, `ls-remote` exit codes, allowlist glob coverage, path-filter completeness → `/simplify` → re-run Step 5.

---

### Task 7: Docs + full verification sweep

Covers spec "Consumption while the repo is private", acceptance items 6 and 9, and the hand-run Gate 1 (this repo has no `scripts/precheck.sh`).

**Files:**
- Create: `go/README.md`
- Modify: `CLAUDE.md` (repo root — "What this repo is" paragraph + command table)

**Interfaces:**
- Consumes: every earlier task's public surface (documented, not called).
- Produces: nothing code-level.

- [ ] **Step 1: Write `go/README.md`**

````markdown
# Go — `entity` (EntitySpec IR producer)

Declare an entity in typed Go and emit the EntitySpec IR — byte-identical to the Node
(`@montionugera/entity-spec`) and Python (`server-decorator-entity`) packages, validated against
`contracts/schemas/entity-spec.schema.json` (conformance is proven by byte parity with the contract fixture). This release ships the IR producer only: no OpenAPI
generator, DTO validators, or HTTP adapters in Go yet.

Module: `github.com/montionugera/node-server-decorator/v2` · package: `.../v2/go/entity` ·
Go 1.22+ · standard library only. Versions move in lockstep with the Node and Python packages.

## Install (private repository)

```bash
go env -w GOPRIVATE=github.com/montionugera/*
git config --global url."git@github.com:".insteadOf "https://github.com/"
go get github.com/montionugera/node-server-decorator/v2@latest
```

While the repository is private, `proxy.golang.org` and `pkg.go.dev` do not serve this module:
there is no rendered API documentation and no module-proxy caching. Versions resolve only from
`vX.Y.Z` git tags; the first Go-resolvable version is the first tag pushed after `go.mod` landed
(`v2.0.0` predates it and does not resolve).

## Declare an entity

```go
import e "github.com/montionugera/node-server-decorator/v2/go/entity"

var UserSpec = e.New("User", "users").
	Transports("rest", "rpc").
	Fields(
		e.Str("id", e.ID, e.Readonly),
		e.Str("email", e.Format("email"), e.Filterable),
		e.Enum("status", e.Values("inactive", "active")),
		e.Int("loginCount", e.Min(0), e.Readonly),
	).
	Actions(e.Act("activate").Transition("status", "inactive", "active")).
	Build()
```

`New` defaults match `@Restful` / `@restful`: transports `rest`, all five ops, `offset` pagination.

## Generate the IR with `go generate`

A prebuilt command cannot import your specs, so add a small generator to your repo:

```go
// internal/genspec/main.go
package main

import (
	"flag"
	"log"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
	"example.com/you/internal/entities"
)

func main() {
	out := flag.String("out", ".", "output directory")
	flag.Parse()
	if err := e.WriteFiles(*out, entities.UserSpec); err != nil {
		log.Fatal(err)
	}
}
```

Next to your specs: `//go:generate go run ../genspec -out ../../spec`. Run `go generate ./...` and
commit the `entity-spec.<path>.json` files. Add a test comparing each committed file with
`e.MarshalCanonical(spec)` so a stale artifact fails CI —
see `go/internal/example/user_test.go` (`TestGeneratedFileIsCurrent`) in this repo.

## Byte-format rules (for contributors)

`go/entity/spec.go` is the only code that knows the byte format. Keep struct fields declared in
sorted JSON-name order, keep `Min`/`Max` as `*int`, and keep `SetEscapeHTML(false)` — each is
guarded by a test in `go/entity/spec_test.go`.
````

- [ ] **Step 2: Update `CLAUDE.md`**

After the first paragraph of "What this repo is", add:

```markdown
A third lane, **Go** (`go/`, module `github.com/montionugera/node-server-decorator/v2`, root `go.mod`), ships only the `entity` IR producer (`go/entity`), byte-identical to the Node/Python `entity` packages; see `go/README.md`.
```

In the "Common commands" table, in the `Entity-spec parity` row only, replace `asserts Node and Python \`entity\` packages` with `asserts Node, Python and Go \`entity\` packages` (the OpenAPI parity row also contains `asserts Node and Python` — leave it). Then add after the `gen_openapi tests` row:

```markdown
| Go tests (byte parity, guards, drift gate) | `go test ./go/...` (repo root; stdlib only, no install) |
| Go hygiene | `test -z "$(gofmt -l go)" && go vet ./go/...` |
| Regenerate Go example IR | `go generate ./go/...` |
```

- [ ] **Step 3: Full verification sweep** — run each line, record exit codes; every one must be `0`:

```bash
L="$TMPDIR/i006-sweep"; mkdir -p "$L"
test -z "$(gofmt -l go)"; echo "gofmt=$?"
go vet ./go/...; echo "vet=$?"
go test ./go/... >"$L/go.log" 2>&1; echo "go-test=$?"; tail -3 "$L/go.log"
(cd node && pnpm -r run build && pnpm -r test:unit) >"$L/node.log" 2>&1; echo "node=$?"; grep -E 'Tests:|Test Suites:' "$L/node.log"
(cd python && bash scripts/check.sh) >"$L/py.log" 2>&1; echo "python=$?"; grep -E 'passed|failed' "$L/py.log" | tail -4
bash scripts/check-entity-parity.sh; echo "entity-parity=$?"
bash scripts/check-openapi-parity.sh; echo "openapi-parity=$?"
bash scripts/check-versions.sh; echo "versions=$?"
bash contracts/scripts/validate.sh >"$L/validate.log" 2>&1; echo "validate=$?"; tail -2 "$L/validate.log"
git status --short   # must list only CLAUDE.md and go/README.md (committed in Step 4)
```

Item 6 (schema validity) is satisfied transitively: `go-test` proves Go bytes equal
`entity-spec.valid-user.json`, and `validate` proves that fixture is schema-valid — `validate.sh`
passes unchanged.

- [ ] **Step 4: Commit**

```bash
git add go/README.md CLAUDE.md
git commit -m "docs(go): Go lane README + CLAUDE.md commands"
```

- [ ] **Step 5: Phase gate** (rule 7): verify (Step 3) → independent review (`code-reviewer`, `model: sonnet`) of the docs against the code actually shipped (every identifier in the README must exist) → `/simplify` → re-run Step 3's `go test` and `check-entity-parity` lines.

---

## After merge to `main` (spec acceptance item 11 — not an implementation task)

Run once the first publish after this change completes on `main`:

```bash
git fetch origin main
v=$(git show origin/main:node/packages/core/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
git ls-remote --tags origin "refs/tags/v$v"          # must print one line
cd "$(mktemp -d)" && go mod init probe && GOPRIVATE=github.com/montionugera/* \
  go list -m "github.com/montionugera/node-server-decorator/v2@v$v"   # must print the module and version
```

This is the only check that exercises private-repo resolution. If it fails, record the error on the
feature's backlog entry; the library code is unaffected.

## Appendix — audit trail

- 2026-09-13 self-grill-audit: verdict safe-with-fixes (0 CRITICAL, 1 HIGH, 4 MEDIUM, 2 LOW; Tasks 1–6 replayed in a scratch copy, every Expected FAIL/PASS, edit anchor, trial bump and CI structural check confirmed). Corrected:
  - HIGH: `SetEscapeHTML(false)` alone leaves U+2028/U+2029 escaped (Go `\u2028` vs raw bytes in Node/Python). Added `unescapeLineSeparators` to `MarshalCanonical`, extended the `html-escape.json` golden (raw U+2028, U+2029, literal `\\u2028`), added guard 2b. Re-verified from plan text: tests pass, removing the call fails.
  - MEDIUM: `TestGeneratedFileIsCurrent` now regenerates through `WriteFiles` into `t.TempDir()` (it compared against `MarshalCanonical`, so a generator bug would pass). Re-verified: missing → fail, generated → pass, hand edit → stale.
  - MEDIUM: go:generate insertion wording fixed to exactly one blank line each side (literal reading made `gofmt -l` flag `user.go`). Re-verified gofmt clean.
  - MEDIUM: Task 7 sweep `git status --short` expectation corrected (it runs before the Step 4 docs commit).
  - LOW: CLAUDE.md edit anchored to the Entity-spec parity row only (the OpenAPI row shares the text).
  Not changed: tag placement (auditor suggested tagging right after the bump push; kept as recorded Spec deviation 2 — a failed PyPI publish leaves that version untagged, which is the intended trade). Key-order test scope (LOW): full-output key order is already covered by Task 2's byte parity against `valid-user`. `spec.md` constraint 3 still names only `SetEscapeHTML`; the plan supersedes it.
  Open: none.

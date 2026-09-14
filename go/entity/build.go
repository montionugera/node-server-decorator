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

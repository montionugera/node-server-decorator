package openapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	e "github.com/montionugera/node-server-decorator/v2/go/entity"
)

// covDig walks nested JSON objects by key and fails the test on a missing step.
func covDig(t *testing.T, doc map[string]any, path ...string) any {
	t.Helper()
	var cur any = doc
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			t.Fatalf("%v: %q is not an object", path[:i], key)
		}
		next, ok := m[key]
		if !ok {
			t.Fatalf("missing key %q at %v", key, path[:i])
		}
		cur = next
	}
	return cur
}

func covGenerate(t *testing.T, specs ...e.Spec) map[string]any {
	t.Helper()
	out, err := Generate(specs, "9.9.9")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("Generate output is not JSON: %v", err)
	}
	return doc
}

func covKeys(m any) []string {
	var keys []string
	for k := range m.(map[string]any) {
		keys = append(keys, k)
	}
	return keys
}

func covHas(m any, key string) bool {
	_, ok := m.(map[string]any)[key]
	return ok
}

func covParamNames(t *testing.T, params any) []string {
	t.Helper()
	var names []string
	for _, p := range params.([]any) {
		names = append(names, p.(map[string]any)["name"].(string))
	}
	return names
}

func TestOpenAPICoverage_Capitalize(t *testing.T) {
	cases := map[string]string{"": "", "a": "A", "activate": "Activate", "Already": "Already", "élan": "Élan", "9x": "9x"}
	for in, want := range cases {
		if got := Capitalize(in); got != want {
			t.Errorf("Capitalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOpenAPICoverage_FormatPattern(t *testing.T) {
	for format, want := range map[string]string{"email": EmailPattern, "uuid": UuidPattern, "uri": UriPattern} {
		got, err := formatPattern(format)
		if err != nil || got != want {
			t.Errorf("formatPattern(%q) = (%q, %v), want the %s pattern", format, got, err, format)
		}
	}
	for _, format := range []string{"", "ipv4", "EMAIL"} {
		got, err := formatPattern(format)
		if err == nil || got != "" || !strings.Contains(err.Error(), "unknown format") {
			t.Errorf("formatPattern(%q) = (%q, %v), want an unknown-format error", format, got, err)
		}
	}
}

func TestOpenAPICoverage_JSONSchemaForField(t *testing.T) {
	cases := []struct {
		name  string
		field e.Field
		want  JSONSchema
	}{
		{"plain string", e.Str("a"), JSONSchema{"type": "string"}},
		{"nullable string", e.Str("a", e.Nullable), JSONSchema{"type": []any{"string", "null"}}},
		{"string bounds incl. zero", e.Str("a", e.Min(0), e.Max(0)), JSONSchema{"type": "string", "minLength": 0, "maxLength": 0}},
		{"uuid format", e.Str("a", e.Format("uuid")), JSONSchema{"type": "string", "format": "uuid", "pattern": UuidPattern}},
		{"uri format", e.Str("a", e.Format("uri")), JSONSchema{"type": "string", "format": "uri", "pattern": UriPattern}},
		{"explicit pattern", e.Str("a", e.Pattern("^[A-Z]+$")), JSONSchema{"type": "string", "pattern": "^[A-Z]+$"}},
		{"ref is a string", e.Ref("ownerId", "User", e.Format("uuid")), JSONSchema{"type": "string", "format": "uuid", "pattern": UuidPattern}},
		{"int bounds", e.Int("a", e.Min(-3), e.Max(10)), JSONSchema{"type": "integer", "minimum": -3, "maximum": 10}},
		{"float max only", e.Float("a", e.Max(1)), JSONSchema{"type": "number", "maximum": 1}},
		{"bool ignores bounds", e.Bool("a", e.Min(1), e.Max(2)), JSONSchema{"type": "boolean"}},
		{"nullable datetime", e.DateTime("a", e.Nullable), JSONSchema{"type": []any{"string", "null"}, "format": "date-time"}},
		{"enum", e.Enum("a", e.Values("x", "y")), JSONSchema{"type": "string", "enum": []any{"x", "y"}}},
		{"enum without values", e.Enum("a"), JSONSchema{"type": "string"}},
		{"description", e.Bool("a", e.Desc("flag")), JSONSchema{"type": "boolean", "description": "flag"}},
		{"list without item", e.List("a"), JSONSchema{"type": "array", "items": JSONSchema{}}},
		{
			"list with bounds",
			e.List("a", e.Of(e.Int("a", e.Min(1))), e.Min(1), e.Max(5)),
			JSONSchema{"type": "array", "items": JSONSchema{"type": "integer", "minimum": 1}, "minItems": 1, "maxItems": 5},
		},
		{
			"empty object",
			e.Obj("a"),
			JSONSchema{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		},
		{
			"object with required and optional members",
			e.Obj("a", e.Sub(e.Str("req"), e.Int("opt", e.Optional))),
			JSONSchema{
				"type": "object",
				"properties": map[string]any{
					"req": JSONSchema{"type": "string"},
					"opt": JSONSchema{"type": "integer"},
				},
				"required":             []string{"req"},
				"additionalProperties": false,
			},
		},
		{
			"object whose members are all optional has no required list",
			e.Obj("a", e.Sub(e.Str("x", e.Optional))),
			JSONSchema{"type": "object", "properties": map[string]any{"x": JSONSchema{"type": "string"}}, "additionalProperties": false},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := JSONSchemaForField(c.field, nil) // nil keep means keep everything
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("\n got %#v\nwant %#v", got, c.want)
			}
		})
	}
}

func TestOpenAPICoverage_JSONSchemaForFieldAppliesKeepRecursively(t *testing.T) {
	field := e.Obj("profile", e.Sub(
		e.Str("bio"),
		e.Str("secret", e.Writeonly),
		e.List("links", e.Of(e.Obj("links", e.Sub(e.Str("url"), e.Str("token", e.Writeonly))))),
	))
	got, err := JSONSchemaForField(field, func(f e.Field) bool { return !f.Writeonly })
	if err != nil {
		t.Fatal(err)
	}
	want := JSONSchema{
		"type": "object",
		"properties": map[string]any{
			"bio": JSONSchema{"type": "string"},
			"links": JSONSchema{
				"type": "array",
				"items": JSONSchema{
					"type":                 "object",
					"properties":           map[string]any{"url": JSONSchema{"type": "string"}},
					"required":             []string{"url"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"bio", "links"},
		"additionalProperties": false,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("\n got %#v\nwant %#v", got, want)
	}
}

func TestOpenAPICoverage_JSONSchemaForFieldErrors(t *testing.T) {
	bad := e.Field{Name: "bad", Type: "decimal"}
	cases := []struct {
		name  string
		field e.Field
		want  string
	}{
		{"unknown type", bad, "unknown field type: decimal"},
		{"empty type", e.Field{Name: "x"}, "unknown field type: "},
		{"unknown format", e.Str("x", e.Format("ipv4")), "unknown format: ipv4"},
		{"bad list item", e.List("x", e.Of(bad)), "unknown field type: decimal"},
		{"bad nested member", e.Obj("x", e.Sub(e.Str("ok"), bad)), "unknown field type: decimal"},
		{"bad deeply nested format", e.Obj("x", e.Sub(e.List("l", e.Of(e.Str("l", e.Format("nope")))))), "unknown format: nope"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := JSONSchemaForField(c.field, nil)
			if err == nil || err.Error() != c.want {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if got != nil {
				t.Errorf("schema = %v, want nil on error", got)
			}
		})
	}
}

func TestOpenAPICoverage_ObjectPropertiesSkipsRejectedFieldsAndPropagatesErrors(t *testing.T) {
	fields := []e.Field{e.Str("keep"), {Name: "drop", Type: "decimal", Readonly: true}}

	props, err := ObjectProperties(fields, func(f e.Field) bool { return !f.Readonly })
	if err != nil {
		t.Fatalf("a rejected field must not be converted: %v", err)
	}
	if !reflect.DeepEqual(props, map[string]any{"keep": JSONSchema{"type": "string"}}) {
		t.Errorf("props = %#v, want only keep", props)
	}

	props, err = ObjectProperties(fields, keepAll)
	if err == nil || props != nil {
		t.Errorf("ObjectProperties = (%v, %v), want (nil, unknown-type error)", props, err)
	}
}

func TestOpenAPICoverage_ListEnvelope(t *testing.T) {
	cursor := listEnvelope("Order", "cursor")
	if !reflect.DeepEqual(cursor["required"], []string{"items", "nextCursor"}) {
		t.Errorf("cursor required = %v", cursor["required"])
	}
	props := cursor["properties"].(JSONSchema)
	if !reflect.DeepEqual(props["nextCursor"], JSONSchema{"type": []any{"string", "null"}}) {
		t.Errorf("nextCursor = %#v, want a nullable string", props["nextCursor"])
	}
	for _, offsetOnly := range []string{"total", "limit", "offset"} {
		if _, ok := props[offsetOnly]; ok {
			t.Errorf("cursor envelope must not have %q", offsetOnly)
		}
	}
	items := props["items"].(JSONSchema)["items"].(JSONSchema)
	if items["$ref"] != "#/components/schemas/OrderRead" {
		t.Errorf("items ref = %v", items["$ref"])
	}

	// Anything that is not "cursor" (including an empty value) is the offset envelope.
	for _, mode := range []string{"offset", "", "page"} {
		offset := listEnvelope("Order", mode)
		if !reflect.DeepEqual(offset["required"], []string{"items", "total", "limit", "offset"}) {
			t.Errorf("pagination %q: required = %v", mode, offset["required"])
		}
		if _, ok := offset["properties"].(JSONSchema)["nextCursor"]; ok {
			t.Errorf("pagination %q: offset envelope must not have nextCursor", mode)
		}
	}
}

func TestOpenAPICoverage_PaginationParams(t *testing.T) {
	names := func(params []JSONSchema) []string {
		var out []string
		for _, p := range params {
			out = append(out, p["name"].(string))
		}
		return out
	}
	cursor := paginationParams(e.Spec{Pagination: "cursor"})
	if !reflect.DeepEqual(names(cursor), []string{"limit", "cursor"}) {
		t.Errorf("cursor params = %v", names(cursor))
	}
	if !reflect.DeepEqual(cursor[1]["schema"], JSONSchema{"type": "string"}) || cursor[1]["required"] != false {
		t.Errorf("cursor param = %#v, want an optional string", cursor[1])
	}

	offset := paginationParams(e.Spec{Pagination: "offset"})
	if !reflect.DeepEqual(names(offset), []string{"limit", "offset"}) {
		t.Errorf("offset params = %v", names(offset))
	}
	if !reflect.DeepEqual(offset[1]["schema"], JSONSchema{"type": "integer", "minimum": 0, "default": 0}) {
		t.Errorf("offset schema = %#v", offset[1]["schema"])
	}
	if !reflect.DeepEqual(offset[0]["schema"], JSONSchema{"type": "integer", "minimum": 1, "maximum": 100, "default": 20}) {
		t.Errorf("limit schema = %#v", offset[0]["schema"])
	}
}

func TestOpenAPICoverage_SchemeObject(t *testing.T) {
	apiKey := schemeObject(e.Scheme{Name: "key", Type: "apiKey", In: "header", ParamName: "X-API-Key", Scheme: "ignored"})
	if !reflect.DeepEqual(apiKey, JSONSchema{"type": "apiKey", "in": "header", "name": "X-API-Key"}) {
		t.Errorf("apiKey scheme = %#v", apiKey)
	}
	basic := schemeObject(e.Scheme{Name: "basic", Type: "http", Scheme: "basic"})
	if !reflect.DeepEqual(basic, JSONSchema{"type": "http", "scheme": "basic"}) {
		t.Errorf("basic scheme = %#v, want no bearerFormat", basic)
	}
	bearer := schemeObject(e.Scheme{Name: "b", Type: "http", Scheme: "bearer", BearerFormat: "JWT"})
	if bearer["bearerFormat"] != "JWT" {
		t.Errorf("bearer scheme = %#v, want bearerFormat JWT", bearer)
	}
}

func TestOpenAPICoverage_SecurityFor(t *testing.T) {
	sec := &e.Security{
		Schemes: []e.Scheme{{Name: "first", Type: "http", Scheme: "bearer"}, {Name: "second", Type: "apiKey"}},
		Ops:     map[string][]string{"list": {"read"}, "get": {}},
		Actions: map[string][]string{"ship": {"write", "admin"}},
	}
	spec := e.Spec{Security: sec}

	if got := securityFor(spec, "list", "ops"); !reflect.DeepEqual(got, []any{map[string]any{"first": []string{"read"}}}) {
		t.Errorf("ops/list = %#v, want the first scheme with [read]", got)
	}
	if got := securityFor(spec, "ship", "actions"); !reflect.DeepEqual(got, []any{map[string]any{"first": []string{"write", "admin"}}}) {
		t.Errorf("actions/ship = %#v", got)
	}
	// A key present with no scopes still requires authentication.
	if got := securityFor(spec, "get", "ops"); !reflect.DeepEqual(got, []any{map[string]any{"first": []string{}}}) {
		t.Errorf("ops/get = %#v, want the scheme with an empty scope list", got)
	}
	// The op and action namespaces are separate.
	if got := securityFor(spec, "ship", "ops"); got != nil {
		t.Errorf("ops/ship = %#v, want nil", got)
	}
	if got := securityFor(spec, "list", "actions"); got != nil {
		t.Errorf("actions/list = %#v, want nil", got)
	}
	if got := securityFor(e.Spec{}, "list", "ops"); got != nil {
		t.Errorf("no security block: got %#v, want nil", got)
	}
	noSchemes := e.Spec{Security: &e.Security{Ops: map[string][]string{"list": {"read"}}}}
	if got := securityFor(noSchemes, "list", "ops"); got != nil {
		t.Errorf("no schemes: got %#v, want nil", got)
	}
}

func TestOpenAPICoverage_HasOp(t *testing.T) {
	if !hasOp([]string{"list", "get"}, "get") {
		t.Error("hasOp must find a present op")
	}
	if hasOp([]string{"list", "get"}, "delete") || hasOp(nil, "list") || hasOp([]string{"List"}, "list") {
		t.Error("hasOp must be false for an absent op, a nil list and a case mismatch")
	}
}

func TestOpenAPICoverage_IdField(t *testing.T) {
	spec := e.New("Order", "orders").Fields(e.Str("name"), e.Int("orderNo", e.ID), e.Str("other", e.ID)).Build()
	id, err := idField(spec)
	if err != nil || id.Name != "orderNo" {
		t.Fatalf("idField = (%+v, %v), want the first role=id field orderNo", id, err)
	}

	_, err = idField(e.New("Order", "orders").Fields(e.Str("name")).Build())
	if err == nil || err.Error() != `Order: no field with role "id"` {
		t.Fatalf("err = %v, want the no-id error", err)
	}
}

func TestOpenAPICoverage_FilterParams(t *testing.T) {
	spec := e.New("Order", "orders").Fields(
		e.Str("id", e.ID),
		e.Enum("status", e.Values("new", "paid"), e.Filterable, e.Nullable, e.Optional),
		e.Int("qty", e.Min(1), e.Filterable),
		e.Str("note"),
	).Build()

	got, err := filterParams(spec)
	if err != nil {
		t.Fatal(err)
	}
	want := []JSONSchema{
		// Nullable is dropped: a query parameter cannot be null.
		{"name": "status", "in": "query", "required": false, "schema": JSONSchema{"type": "string", "enum": []any{"new", "paid"}}},
		{"name": "qty", "in": "query", "required": false, "schema": JSONSchema{"type": "integer", "minimum": 1}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("\n got %#v\nwant %#v", got, want)
	}

	none, err := filterParams(e.New("Order", "orders").Fields(e.Str("id", e.ID)).Build())
	if err != nil || len(none) != 0 {
		t.Errorf("no filterable fields: got (%v, %v), want none", none, err)
	}

	broken := e.New("Order", "orders").Fields(e.Field{Name: "x", Type: "decimal", Filterable: true}).Build()
	if got, err := filterParams(broken); err == nil || got != nil {
		t.Errorf("filterParams = (%v, %v), want (nil, unknown-type error)", got, err)
	}
}

func TestOpenAPICoverage_GenerateErrors(t *testing.T) {
	bad := e.Field{Name: "bad", Type: "decimal"}
	id := e.Str("id", e.ID, e.Readonly)
	cases := []struct {
		name string
		spec e.Spec
		want string
	}{
		{"bad writable field (create schema)", e.New("A", "as").Ops("get").Fields(id, bad).Build(), "unknown field type: decimal"},
		{
			"bad readonly field (read schema only)",
			e.New("A", "as").Ops("get").Fields(id, e.Field{Name: "bad", Type: "decimal", Readonly: true}).Build(),
			"unknown field type: decimal",
		},
		{
			"bad action input",
			e.New("A", "as").Ops("get").Fields(id).Actions(e.Act("go").In(e.Str("x", e.Format("nope")))).Build(),
			"unknown format: nope",
		},
		{"no id field", e.New("A", "as").Ops("get").Fields(e.Str("name")).Build(), `A: no field with role "id"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := Generate([]e.Spec{c.spec}, "1.0.0")
			if err == nil || err.Error() != c.want {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if out != nil {
				t.Errorf("output = %s, want nil on error", out)
			}
		})
	}
}

func TestOpenAPICoverage_PathsErrors(t *testing.T) {
	// openapiPaths is reached only after the components pass in Generate, so its own error
	// branches are exercised directly.
	badID := e.New("A", "as").Ops("get").Fields(e.Field{Name: "id", Type: "decimal", Role: "id"}).Build()
	if paths, err := openapiPaths(badID); err == nil || paths != nil {
		t.Errorf("bad id type: got (%v, %v), want (nil, error)", paths, err)
	}

	badFilter := e.New("A", "as").Ops("list").Fields(e.Str("id", e.ID), e.Field{Name: "f", Type: "decimal", Filterable: true}).Build()
	if paths, err := openapiPaths(badFilter); err == nil || paths != nil {
		t.Errorf("bad filter field: got (%v, %v), want (nil, error)", paths, err)
	}

	// The same field is harmless when the list op is not exposed.
	badFilter.Ops = []string{"get"}
	if _, err := openapiPaths(badFilter); err != nil {
		t.Errorf("filter fields must be ignored without the list op: %v", err)
	}
}

func TestOpenAPICoverage_GenerateCursorApiKeyDocument(t *testing.T) {
	orders := e.New("Order", "orders").
		Tags("sales", "billing").
		Ops("list", "get").
		Pagination("cursor").
		Fields(
			e.Str("id", e.ID, e.Readonly, e.Format("uuid")),
			e.Int("qty", e.Min(1)),
		).
		Actions(
			e.Act("ship").Desc("Ship it").Transition("status", "paid", "shipped").In(e.Str("carrier")),
			e.Act("ping"),
		).
		Secure(e.Security{
			Schemes: []e.Scheme{
				{Name: "apiKeyAuth", Type: "apiKey", In: "header", ParamName: "X-API-Key"},
				{Name: "basicAuth", Type: "http", Scheme: "basic"},
			},
			Ops:     map[string][]string{"list": {"order:read"}, "get": {"order:read"}},
			Actions: map[string][]string{"ship": {"order:write"}},
		}).
		Build()
	notes := e.New("Note", "notes").Tags("admin", "sales").Ops("create").Pagination("offset").
		Fields(e.Int("id", e.ID, e.Readonly), e.Str("body")).Build()

	doc := covGenerate(t, orders, notes)

	if v := covDig(t, doc, "info", "version"); v != "9.9.9" {
		t.Errorf("info.version = %v", v)
	}
	if v := covDig(t, doc, "openapi"); v != "3.1.0" {
		t.Errorf("openapi = %v", v)
	}

	// Tags are the sorted, de-duplicated union across specs.
	wantTags := []any{map[string]any{"name": "admin"}, map[string]any{"name": "billing"}, map[string]any{"name": "sales"}}
	if !reflect.DeepEqual(doc["tags"], wantTags) {
		t.Errorf("tags = %v, want %v", doc["tags"], wantTags)
	}

	schemes := covDig(t, doc, "components", "securitySchemes")
	wantSchemes := map[string]any{
		"apiKeyAuth": map[string]any{"type": "apiKey", "in": "header", "name": "X-API-Key"},
		"basicAuth":  map[string]any{"type": "http", "scheme": "basic"},
	}
	if !reflect.DeepEqual(schemes, wantSchemes) {
		t.Errorf("securitySchemes = %v, want %v", schemes, wantSchemes)
	}

	// Only the ops that were asked for are exposed.
	paths := covDig(t, doc, "paths")
	if got := covKeys(covDig(t, doc, "paths", "/orders")); !reflect.DeepEqual(got, []string{"get"}) {
		t.Errorf("/orders methods = %v, want [get]", got)
	}
	if got := covKeys(covDig(t, doc, "paths", "/orders/{id}")); !reflect.DeepEqual(got, []string{"get"}) {
		t.Errorf("/orders/{id} methods = %v, want [get]", got)
	}
	if got := covKeys(covDig(t, doc, "paths", "/notes")); !reflect.DeepEqual(got, []string{"post"}) {
		t.Errorf("/notes methods = %v, want [post]", got)
	}
	if covHas(paths, "/notes/{id}") {
		t.Error("/notes/{id} must be absent: Note exposes no item op and no action")
	}

	// list: cursor paging, sorted params, security from ops, no 400 without filterable fields.
	list := covDig(t, doc, "paths", "/orders", "get")
	if got := covParamNames(t, covDig(t, doc, "paths", "/orders", "get", "parameters")); !reflect.DeepEqual(got, []string{"cursor", "limit"}) {
		t.Errorf("list params = %v, want [cursor limit]", got)
	}
	wantSec := []any{map[string]any{"apiKeyAuth": []any{"order:read"}}}
	if !reflect.DeepEqual(list.(map[string]any)["security"], wantSec) {
		t.Errorf("list security = %v, want %v", list.(map[string]any)["security"], wantSec)
	}
	if got := covKeys(covDig(t, doc, "paths", "/orders", "get", "responses")); !reflect.DeepEqual(got, []string{"200"}) {
		t.Errorf("list responses = %v, want only 200", got)
	}
	if !reflect.DeepEqual(list.(map[string]any)["tags"], []any{"sales", "billing"}) {
		t.Errorf("list tags = %v, want the spec's own tags in declaration order", list.(map[string]any)["tags"])
	}

	get := covDig(t, doc, "paths", "/orders/{id}", "get").(map[string]any)
	if !reflect.DeepEqual(get["security"], wantSec) {
		t.Errorf("get security = %v, want %v", get["security"], wantSec)
	}
	idParam := get["parameters"].([]any)[0].(map[string]any)
	wantIDSchema := map[string]any{"type": "string", "format": "uuid", "pattern": UuidPattern}
	if idParam["in"] != "path" || idParam["required"] != true || !reflect.DeepEqual(idParam["schema"], wantIDSchema) {
		t.Errorf("id param = %v", idParam)
	}

	// create on Note has no scope entry, so no security requirement.
	if covHas(covDig(t, doc, "paths", "/notes", "post"), "security") {
		t.Error("create on Note must not carry a security requirement")
	}

	// A transition action can conflict (409); a plain action cannot.
	ship := covDig(t, doc, "paths", "/orders/{id}/actions/ship", "post").(map[string]any)
	if ship["operationId"] != "shipOrder" || ship["description"] != "Ship it" {
		t.Errorf("ship op = %v / %v", ship["operationId"], ship["description"])
	}
	if !covHas(ship["responses"], "409") {
		t.Error("ship is a transition and must document 409")
	}
	if !reflect.DeepEqual(ship["security"], []any{map[string]any{"apiKeyAuth": []any{"order:write"}}}) {
		t.Errorf("ship security = %v", ship["security"])
	}
	ping := covDig(t, doc, "paths", "/orders/{id}/actions/ping", "post").(map[string]any)
	if covHas(ping["responses"], "409") || covHas(ping, "security") || covHas(ping, "description") {
		t.Errorf("ping must have no 409, security or description: %v", ping)
	}

	// Component schemas.
	envelope := covDig(t, doc, "components", "schemas", "OrderListResponse").(map[string]any)
	if !reflect.DeepEqual(envelope["required"], []any{"items", "nextCursor"}) {
		t.Errorf("OrderListResponse required = %v", envelope["required"])
	}
	noteEnvelope := covDig(t, doc, "components", "schemas", "NoteListResponse").(map[string]any)
	if !reflect.DeepEqual(noteEnvelope["required"], []any{"items", "total", "limit", "offset"}) {
		t.Errorf("NoteListResponse required = %v", noteEnvelope["required"])
	}
	create := covDig(t, doc, "components", "schemas", "OrderCreate").(map[string]any)
	if covHas(create["properties"], "id") || !reflect.DeepEqual(create["required"], []any{"qty"}) {
		t.Errorf("OrderCreate = %v, want no readonly id and required [qty]", create)
	}
	update := covDig(t, doc, "components", "schemas", "OrderUpdate").(map[string]any)
	if covHas(update, "required") || !covHas(update["properties"], "qty") {
		t.Errorf("OrderUpdate = %v, want qty with no required list", update)
	}
	shipInput := covDig(t, doc, "components", "schemas", "OrderShipInput").(map[string]any)
	if !reflect.DeepEqual(shipInput["required"], []any{"carrier"}) {
		t.Errorf("OrderShipInput required = %v", shipInput["required"])
	}
	pingInput := covDig(t, doc, "components", "schemas", "OrderPingInput").(map[string]any)
	if covHas(pingInput, "required") || len(pingInput["properties"].(map[string]any)) != 0 {
		t.Errorf("OrderPingInput = %v, want an empty strict object", pingInput)
	}
}

func TestOpenAPICoverage_GenerateWithoutSpecsOrOptionalSections(t *testing.T) {
	empty := covGenerate(t)
	if covHas(empty, "tags") {
		t.Error("tags must be omitted when no spec declares any")
	}
	if covHas(covDig(t, empty, "components"), "securitySchemes") {
		t.Error("securitySchemes must be omitted without a security block")
	}
	if len(covDig(t, empty, "paths").(map[string]any)) != 0 {
		t.Errorf("paths = %v, want none", empty["paths"])
	}
	schemas := covDig(t, empty, "components", "schemas").(map[string]any)
	if len(schemas) != 2 || !covHas(schemas, "Problem") || !covHas(schemas, "ValidationProblem") {
		t.Errorf("schemas = %v, want only the two problem schemas", covKeys(schemas))
	}

	// A spec with no ops still documents its id-scoped action, and nothing else.
	bare := e.New("Job", "jobs").Fields(e.Str("id", e.ID)).Actions(e.Act("run")).Build()
	bare.Ops = nil
	doc := covGenerate(t, bare)
	if got := covKeys(covDig(t, doc, "paths")); !reflect.DeepEqual(got, []string{"/jobs/{id}/actions/run"}) {
		t.Errorf("paths = %v, want only the action path", got)
	}
	if covHas(doc, "tags") || covHas(covDig(t, doc, "paths", "/jobs/{id}/actions/run", "post"), "tags") {
		t.Error("an untagged spec must not emit tags")
	}
}

func TestOpenAPICoverage_GenerateDoesNotEscapeHTMLOrAppendNewline(t *testing.T) {
	spec := e.New("Doc", "docs").Ops("get").Fields(e.Str("id", e.ID, e.Desc("a < b && c > d"))).Build()
	out, err := Generate([]e.Spec{spec}, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "a < b && c > d") {
		t.Errorf("description was HTML-escaped: %s", out)
	}
	if strings.HasSuffix(string(out), "\n") {
		t.Error("output must not end with a newline")
	}
}

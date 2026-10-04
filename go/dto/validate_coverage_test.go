package dto

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

func covIntPtr(i int) *int { return &i }

const covUUID = "123e4567-e89b-12d3-a456-426614174000"

var covSpec = entity.Spec{
	Entity: "Widget",
	Path:   "widgets",
	Fields: []entity.Field{
		{Name: "id", Type: "str", Format: "uuid", Readonly: true},
		{Name: "email", Type: "str", Format: "email"},
		{Name: "name", Type: "str", Min: covIntPtr(2), Max: covIntPtr(5)},
		{Name: "site", Type: "str", Format: "uri", Optional: true},
		{Name: "code", Type: "str", Pattern: `^[A-Z]{3}$`, Optional: true},
		{Name: "badPattern", Type: "str", Pattern: `([`, Optional: true},
		{Name: "age", Type: "int", Min: covIntPtr(0), Max: covIntPtr(150), Optional: true},
		{Name: "ratio", Type: "float", Min: covIntPtr(0), Max: covIntPtr(1), Optional: true},
		{Name: "active", Type: "bool", Optional: true},
		{Name: "status", Type: "enum", Enum: []string{"a", "b"}, Optional: true},
		{Name: "born", Type: "datetime", Optional: true, Nullable: true},
		{Name: "tags", Type: "list", Optional: true, Item: &entity.Field{Name: "tags", Type: "str", Min: covIntPtr(1)}},
		{Name: "nums", Type: "list", Optional: true, Item: &entity.Field{Name: "nums", Type: "int", Nullable: true}},
		{Name: "anything", Type: "list", Optional: true},
		{Name: "profile", Type: "obj", Optional: true, Fields: []entity.Field{
			{Name: "bio", Type: "str", Optional: true},
			{Name: "karma", Type: "int", Optional: true, Readonly: true},
			{Name: "pin", Type: "str", Optional: true, Writeonly: true},
		}},
		{Name: "owner", Type: "ref", Ref: "User", Optional: true},
		{Name: "secret", Type: "str", Optional: true, Writeonly: true},
		{Name: "weird", Type: "tuple", Optional: true},
	},
	Actions: []entity.Action{
		{Name: "rename", Input: []entity.Field{{Name: "to", Type: "str", Min: covIntPtr(1)}}},
		{Name: "ping"},
	},
}

// covCreate returns a valid create payload plus the given extra members.
func covCreate(extra map[string]any) map[string]any {
	p := map[string]any{"email": "a@b.co", "name": "abc"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func covRead(extra map[string]any) map[string]any {
	p := covCreate(extra)
	if _, ok := p["id"]; !ok {
		p["id"] = covUUID
	}
	return p
}

func covCheck(t *testing.T, dtoType string, payload any, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	got, ok := Validate(covSpec, dtoType, payload)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Validate(%s, %v) fields = %v, want %v", dtoType, payload, got, want)
	}
	if ok != (len(want) == 0) {
		t.Errorf("Validate(%s, %v) ok = %v with fields %v", dtoType, payload, ok, got)
	}
}

func TestValidateCoverage_DTOSelection(t *testing.T) {
	covCheck(t, "bogus", covCreate(nil), "_dto")
	covCheck(t, "", covCreate(nil), "_dto")
	covCheck(t, "action:nope", map[string]any{}, "_action")
	covCheck(t, "action:", map[string]any{}, "_action")

	// A valid payload returns a non-nil empty slice so it encodes as [] rather than null.
	got, ok := Validate(covSpec, "create", covCreate(nil))
	if !ok || got == nil || len(got) != 0 {
		t.Fatalf("valid payload = (%#v, %v), want ([]string{}, true)", got, ok)
	}

	// Missing required members come back sorted.
	covCheck(t, "create", map[string]any{}, "email", "name")
	covCheck(t, "create", map[string]any{"zzz": 1, "aaa": 1}, "aaa", "email", "name", "zzz")
}

func TestValidateCoverage_RootMustBeObject(t *testing.T) {
	for _, payload := range []any{nil, "str", []any{}, 5, true, map[string]string{"email": "a@b.co"}} {
		covCheck(t, "create", payload, "_root")
	}
}

func TestValidateCoverage_ReadonlyWriteonlyPerDTO(t *testing.T) {
	// create/update: readonly members are not part of the DTO, so sending one is an unknown key.
	covCheck(t, "create", covCreate(map[string]any{"id": covUUID}), "id")
	covCheck(t, "update", map[string]any{"id": covUUID}, "id")
	covCheck(t, "create", covCreate(map[string]any{"secret": "s"}))
	covCheck(t, "create", covCreate(map[string]any{"profile": map[string]any{"karma": 1}}), "profile.karma")
	covCheck(t, "create", covCreate(map[string]any{"profile": map[string]any{"pin": "1234"}}))

	// read: readonly is required/allowed, writeonly is excluded, at every nesting level.
	covCheck(t, "read", covCreate(nil), "id")
	covCheck(t, "read", covRead(nil))
	covCheck(t, "read", covRead(map[string]any{"id": "not-a-uuid"}), "id")
	covCheck(t, "read", covRead(map[string]any{"secret": "s"}), "secret")
	covCheck(t, "read", covRead(map[string]any{"profile": map[string]any{"karma": 1}}))
	covCheck(t, "read", covRead(map[string]any{"profile": map[string]any{"pin": "1234"}}), "profile.pin")
}

func TestValidateCoverage_UpdateMakesEveryFieldOptionalButStillValidates(t *testing.T) {
	covCheck(t, "update", map[string]any{})
	covCheck(t, "update", map[string]any{"name": "abc"})
	covCheck(t, "update", map[string]any{"name": "a"}, "name")
	// Optional is not nullable: an explicit null is still rejected.
	covCheck(t, "update", map[string]any{"name": nil}, "name")
	covCheck(t, "update", map[string]any{"born": nil})
}

func TestValidateCoverage_Strings(t *testing.T) {
	ok := func(extra map[string]any) { t.Helper(); covCheck(t, "create", covCreate(extra)) }
	bad := func(field string, v any) {
		t.Helper()
		covCheck(t, "create", covCreate(map[string]any{field: v}), field)
	}

	// length boundaries (min 2, max 5)
	ok(map[string]any{"name": "ab"})
	ok(map[string]any{"name": "abcde"})
	bad("name", "a")
	bad("name", "")
	bad("name", "abcdef")
	bad("name", 5)
	bad("name", nil)

	bad("email", "not-an-email")
	bad("email", "a@")
	bad("email", "")

	ok(map[string]any{"site": "https://example.com/x?y=1"})
	bad("site", "example.com")
	bad("site", "https://has space")

	ok(map[string]any{"code": "ABC"})
	bad("code", "abc")
	bad("code", "ABCD")
	// An uncompilable pattern in the spec fails closed instead of accepting everything.
	bad("badPattern", "anything")

	ok(map[string]any{"owner": "user-1"})
	bad("owner", 12)
}

func TestValidateCoverage_Ints(t *testing.T) {
	ok := func(v any) { t.Helper(); covCheck(t, "create", covCreate(map[string]any{"age": v})) }
	bad := func(v any) { t.Helper(); covCheck(t, "create", covCreate(map[string]any{"age": v}), "age") }

	// json.Number, as produced by a decoder with UseNumber
	ok(json.Number("0"))
	ok(json.Number("150"))
	ok(json.Number("5.0"))
	ok(json.Number("1e2"))
	bad(json.Number("-1"))
	bad(json.Number("151"))
	bad(json.Number("5.5"))
	bad(json.Number("1e3"))
	bad(json.Number("abc"))

	// float64, as produced by the default decoder
	ok(float64(0))
	ok(float64(150))
	bad(float64(7.5))
	bad(float64(-1))
	bad(float64(151))
	bad(math.NaN())

	ok(int(3))
	bad(int(200))
	ok(int64(3))
	bad(int64(-2))

	bad("7")
	bad(true)
	bad([]any{})
}

func TestValidateCoverage_Floats(t *testing.T) {
	ok := func(v any) { t.Helper(); covCheck(t, "create", covCreate(map[string]any{"ratio": v})) }
	bad := func(v any) { t.Helper(); covCheck(t, "create", covCreate(map[string]any{"ratio": v}), "ratio") }

	ok(json.Number("0.5"))
	ok(json.Number("0"))
	ok(json.Number("1"))
	bad(json.Number("1.0001"))
	bad(json.Number("-0.1"))
	bad(json.Number("x"))

	ok(float64(0))
	ok(float64(1))
	bad(float64(1.5))
	bad(float64(-0.0001))
	bad(math.Inf(1))
	bad(math.Inf(-1))

	ok(int(1))
	bad(int(2))
	ok(int64(0))
	bad(int64(-1))

	bad("0.5")
	bad(false)
}

func TestValidateCoverage_BoolAndEnum(t *testing.T) {
	covCheck(t, "create", covCreate(map[string]any{"active": true}))
	covCheck(t, "create", covCreate(map[string]any{"active": false}))
	covCheck(t, "create", covCreate(map[string]any{"active": "true"}), "active")
	covCheck(t, "create", covCreate(map[string]any{"active": 1}), "active")

	covCheck(t, "create", covCreate(map[string]any{"status": "a"}))
	covCheck(t, "create", covCreate(map[string]any{"status": "b"}))
	covCheck(t, "create", covCreate(map[string]any{"status": "c"}), "status")
	covCheck(t, "create", covCreate(map[string]any{"status": "A"}), "status")
	covCheck(t, "create", covCreate(map[string]any{"status": ""}), "status")
	covCheck(t, "create", covCreate(map[string]any{"status": 1}), "status")
}

func TestValidateCoverage_DateTime(t *testing.T) {
	for _, s := range []string{
		"2024-01-02T03:04:05Z",
		"2024-01-02T03:04:05+07:00",
		"2024-01-02T03:04:05-23:59",
		"2024-01-02T03:04:05.123456789Z",
	} {
		covCheck(t, "create", covCreate(map[string]any{"born": s}))
	}
	for _, v := range []any{
		"2024-01-02T03:04:05",       // no offset
		"2024-01-02 03:04:05Z",      // space instead of T
		"2024-01-02T03:04:05,5Z",    // comma fraction
		"2024-13-02T03:04:05Z",      // month 13
		"2024-02-30T03:04:05Z",      // day out of range
		"2024-01-02T03:04:05+24:00", // offset hour out of range
		"2024-01-02",
		"not-a-date",
		"",
		1704164645,
		true,
	} {
		covCheck(t, "create", covCreate(map[string]any{"born": v}), "born")
	}
	covCheck(t, "create", covCreate(map[string]any{"born": nil})) // nullable
}

func TestHasExplicitUTCOffsetCoverage(t *testing.T) {
	for s, want := range map[string]bool{
		"2024-01-02T03:04:05Z":      true,
		"2024-01-02T03:04:05z":      true,
		"2024-01-02T03:04:05+07:00": true,
		"2024-01-02T03:04:05-07:00": true,
		"2024-01-02T03:04:05":       false,
		"2024-01-02T03:04:05+0700":  false,
		"2024":                      false,
		"":                          false,
	} {
		if got := hasExplicitUTCOffset(s); got != want {
			t.Errorf("hasExplicitUTCOffset(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestValidateCoverage_Lists(t *testing.T) {
	covCheck(t, "create", covCreate(map[string]any{"tags": []any{}}))
	covCheck(t, "create", covCreate(map[string]any{"tags": []any{"a", "b"}}))
	covCheck(t, "create", covCreate(map[string]any{"tags": "a"}), "tags")
	covCheck(t, "create", covCreate(map[string]any{"tags": map[string]any{}}), "tags")
	covCheck(t, "create", covCreate(map[string]any{"tags": []string{"a"}}), "tags") // not a decoded JSON array
	covCheck(t, "create", covCreate(map[string]any{"tags": []any{"a", "", 3, nil, "ok"}}), "tags.1", "tags.2", "tags.3")

	// nullable items may be null; other items still validate
	covCheck(t, "create", covCreate(map[string]any{"nums": []any{nil, json.Number("1"), float64(2)}}))
	covCheck(t, "create", covCreate(map[string]any{"nums": []any{"x", 1.5}}), "nums.0", "nums.1")

	// a list without an item spec only checks the container
	covCheck(t, "create", covCreate(map[string]any{"anything": []any{1, "x", nil, map[string]any{}}}))
	covCheck(t, "create", covCreate(map[string]any{"anything": "x"}), "anything")
}

func TestValidateCoverage_NestedObjectsAndUnknownTypes(t *testing.T) {
	covCheck(t, "create", covCreate(map[string]any{"profile": map[string]any{}}))
	covCheck(t, "create", covCreate(map[string]any{"profile": map[string]any{"bio": "hi"}}))
	covCheck(t, "create", covCreate(map[string]any{"profile": "str"}), "profile")
	covCheck(t, "create", covCreate(map[string]any{"profile": []any{}}), "profile")
	covCheck(t, "create", covCreate(map[string]any{"profile": nil}), "profile")
	covCheck(t, "create", covCreate(map[string]any{"profile": map[string]any{"bio": 5, "extra": 1}}),
		"profile.bio", "profile.extra")

	// A field type the validator does not know is rejected, never silently accepted.
	covCheck(t, "create", covCreate(map[string]any{"weird": []any{1, 2}}), "weird")
	covCheck(t, "create", covCreate(map[string]any{"weird": "x"}), "weird")
}

func TestValidateCoverage_Actions(t *testing.T) {
	covCheck(t, "action:rename", map[string]any{"to": "x"})
	covCheck(t, "action:rename", map[string]any{}, "to")
	covCheck(t, "action:rename", map[string]any{"to": ""}, "to")
	covCheck(t, "action:rename", map[string]any{"to": "x", "name": "abc"}, "name")
	covCheck(t, "action:rename", nil, "_root")

	// An action without inputs accepts only an empty object.
	covCheck(t, "action:ping", map[string]any{})
	covCheck(t, "action:ping", map[string]any{"x": 1}, "x")
}

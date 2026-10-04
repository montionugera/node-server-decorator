package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
)

type ckCovPrice float64

type ckCovPoint struct {
	Y int    `json:"y"`
	X string `json:"x"`
}

type ckCovUnmarshalable struct {
	C chan int
}

type ckCovNaNHolder struct {
	F float64 `json:"f"`
}

type ckCovPanicMarshaler struct{}

func (ckCovPanicMarshaler) MarshalJSON() ([]byte, error) { panic("boom from MarshalJSON") }

func TestStableStringifyScalarKinds(t *testing.T) {
	seven := 7
	var nilPtr *int
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"nil", nil, "null"},
		{"true", true, "true"},
		{"false", false, "false"},
		{"int zero", 0, "0"},
		{"int negative", -42, "-42"},
		{"int8 min", int8(math.MinInt8), "-128"},
		{"int16 max", int16(math.MaxInt16), "32767"},
		{"int32 min", int32(math.MinInt32), "-2147483648"},
		{"int64 min", int64(math.MinInt64), "-9223372036854775808"},
		{"int64 max", int64(math.MaxInt64), "9223372036854775807"},
		{"uint", uint(5), "5"},
		{"uint8 max", uint8(math.MaxUint8), "255"},
		{"uint16 max", uint16(math.MaxUint16), "65535"},
		{"uint32 max", uint32(math.MaxUint32), "4294967295"},
		{"uint64 max", uint64(math.MaxUint64), "18446744073709551615"},
		{"float32", float32(1.5), "1.5"},
		{"float64 fraction", 0.25, "0.25"},
		{"float64 negative zero fraction", -2.5, "-2.5"},
		{"json.Number keeps its literal", json.Number("12345678901234567890"), "12345678901234567890"},
		{"named float", ckCovPrice(9.75), "9.75"},
		{"nil typed pointer", nilPtr, "null"},
		{"pointer is dereferenced", &seven, "7"},
		{"empty string", "", `""`},
		{"html chars are not escaped", "<a&b>", `"<a&b>"`},
		{"control char", "a\x01b", `"a\u0001b"`},
		{"quote and backslash", `a"b\c`, `"a\"b\\c"`},
		{"complex falls back to quoted fmt.Sprint", complex(1, 2), `"(1+2i)"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stableStringify(tc.in); got != tc.want {
				t.Fatalf("stableStringify(%#v) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestStableStringifyCollections(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"empty []any", []any{}, "[]"},
		{"[]any mixed", []any{1, "a", nil, true}, `[1,"a",null,true]`},
		{"typed slice", []int{3, 1, 2}, "[3,1,2]"},
		{"nil typed slice", []string(nil), "[]"},
		{"array", [2]string{"x", "y"}, `["x","y"]`},
		{"nested typed slice", [][]bool{{true}, {}}, "[[true],[]]"},
		{"empty map", map[string]any{}, "{}"},
		{"map[string]any sorted", map[string]any{"b": 1, "a": []any{2}}, `{"a":[2],"b":1}`},
		{"typed map sorted by key", map[string]int{"z": 1, "m": 2, "a": 3}, `{"a":3,"m":2,"z":1}`},
		// Non-string keys are ordered by their fmt.Sprint form, i.e. lexicographically.
		{"int-keyed map sorted by string form", map[int]string{10: "ten", 2: "two", 1: "one"}, `{"1":"one","10":"ten","2":"two"}`},
		{"struct uses json tags with sorted keys", ckCovPoint{Y: 2, X: "p"}, `{"x":"p","y":2}`},
		{"pointer to struct", &ckCovPoint{Y: 0, X: ""}, `{"x":"","y":0}`},
		{"slice of structs", []ckCovPoint{{Y: 1, X: "a"}}, `[{"x":"a","y":1}]`},
		{"unmarshalable struct falls back to quoted fmt.Sprint", ckCovUnmarshalable{}, `"{<nil>}"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stableStringify(tc.in); got != tc.want {
				t.Fatalf("stableStringify(%#v) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestStableStringifyIsOrderIndependentForMaps(t *testing.T) {
	a := map[string]any{"k1": map[string]any{"x": 1, "y": 2}, "k2": "v"}
	b := map[string]any{"k2": "v", "k1": map[string]any{"y": 2, "x": 1}}
	for i := 0; i < 20; i++ {
		if stableStringify(a) != stableStringify(b) {
			t.Fatalf("equal maps stringified differently: %s vs %s", stableStringify(a), stableStringify(b))
		}
	}
}

func TestBuildCacheKeyEFormatsArgsAndSortedKwargs(t *testing.T) {
	key, err := BuildCacheKeyE("Svc.get", []any{1, "a"}, map[string]any{"z": true, "b": nil})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := `Svc.get(1,"a",b=null,z=true)`; key != want {
		t.Fatalf("key = %s, want %s", key, want)
	}

	empty, err := BuildCacheKeyE("Svc.get", nil, nil)
	if err != nil || empty != "Svc.get()" {
		t.Fatalf("empty-args key = %q, err = %v, want Svc.get()", empty, err)
	}
}

func TestBuildCacheKeyHashesOnlyAboveMaxKeyBytes(t *testing.T) {
	// raw = `Q("` + pad + `")` -> len(pad) + 5 bytes.
	atLimit := strings.Repeat("x", MaxKeyBytes-5)
	raw := `Q("` + atLimit + `")`
	if len(raw) != MaxKeyBytes {
		t.Fatalf("test setup: raw is %d bytes, want %d", len(raw), MaxKeyBytes)
	}
	if got := BuildCacheKey("Q", []any{atLimit}, nil); got != raw {
		t.Fatalf("key of exactly MaxKeyBytes must stay raw, got %s", got)
	}

	over := atLimit + "x"
	rawOver := `Q("` + over + `")`
	sum := sha256.Sum256([]byte(rawOver))
	want := "Q(sha256:" + hex.EncodeToString(sum[:]) + ")"
	if got := BuildCacheKey("Q", []any{over}, nil); got != want {
		t.Fatalf("key above MaxKeyBytes = %s, want %s", got, want)
	}
}

func TestBuildCacheKeyCountsBytesNotRunes(t *testing.T) {
	// 100 three-byte runes: 100 runes but 305 raw bytes, so it must be hashed.
	arg := strings.Repeat("ก", 100)
	got := BuildCacheKey("Q", []any{arg}, nil)
	if !strings.HasPrefix(got, "Q(sha256:") {
		t.Fatalf("multi-byte key over the byte limit was not hashed: %s", got)
	}
}

func TestBuildCacheKeyERejectsNonFiniteFloats(t *testing.T) {
	nan := math.NaN()
	cases := map[string]any{
		"NaN":                  math.NaN(),
		"+Inf":                 math.Inf(1),
		"-Inf":                 math.Inf(-1),
		"float32 NaN":          float32(math.NaN()),
		"named float NaN":      ckCovPrice(math.NaN()),
		"nested in []any":      []any{1, math.Inf(1)},
		"nested in map":        map[string]any{"a": math.NaN()},
		"nested in typed list": []float64{1, math.NaN()},
		"behind a pointer":     &nan,
		"inside a struct":      ckCovNaNHolder{F: math.NaN()},
	}
	for name, arg := range cases {
		t.Run(name, func(t *testing.T) {
			key, err := BuildCacheKeyE("Q", []any{arg}, nil)
			if !errors.Is(err, ErrNonFiniteCacheArg) {
				t.Fatalf("err = %v, want ErrNonFiniteCacheArg", err)
			}
			if key != "" {
				t.Fatalf("key = %q, want empty on error", key)
			}
		})
	}

	if _, err := BuildCacheKeyE("Q", nil, map[string]any{"k": math.NaN()}); !errors.Is(err, ErrNonFiniteCacheArg) {
		t.Fatalf("kwargs NaN: err = %v, want ErrNonFiniteCacheArg", err)
	}
}

func TestBuildCacheKeyPanicsWithNonFiniteError(t *testing.T) {
	defer func() {
		r := recover()
		err, ok := r.(error)
		if !ok || !errors.Is(err, ErrNonFiniteCacheArg) {
			t.Fatalf("recovered %v, want a panic wrapping ErrNonFiniteCacheArg", r)
		}
	}()
	BuildCacheKey("Q", []any{math.NaN()}, nil)
	t.Fatal("BuildCacheKey returned instead of panicking")
}

func TestBuildCacheKeyERepanicsOnUnrelatedPanic(t *testing.T) {
	defer func() {
		r := recover()
		if r != "boom from MarshalJSON" {
			t.Fatalf("recovered %v, want the original foreign panic value", r)
		}
	}()
	_, _ = BuildCacheKeyE("Q", []any{ckCovPanicMarshaler{}}, nil)
	t.Fatal("BuildCacheKeyE swallowed a panic that is not ErrNonFiniteCacheArg")
}

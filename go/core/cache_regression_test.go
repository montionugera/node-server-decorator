package core_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

// Regression tests for confirmed cache / cache-key defects.
// Spec: contracts/rules/cache-key.md and contracts/rules/cache-adapter.md.

func TestBuildCacheKey_StringsStayUTF8AndUnescaped(t *testing.T) {
	type named map[string]string

	cases := []struct {
		name string
		args []any
		want string
	}{
		{"non-ascii and html in value", []any{"é<a>&"}, `F.b("é<a>&")`},
		{"html in map[string]any key", []any{map[string]any{"<k&>": "v"}}, `F.b({"<k&>":"v"})`},
		{"html in reflected map key", []any{named{"<k&>": "<v>"}}, `F.b({"<k&>":"<v>"})`},
		{"html in struct field", []any{struct {
			URL string `json:"url"`
		}{"a?x=1&y=<2>"}}, `F.b({"url":"a?x=1&y=<2>"})`},
		{"quotes and backslash", []any{`a"b\c`}, `F.b("a\"b\\c")`},
		{"short control escapes", []any{"\b\f\n\r\t"}, `F.b("\b\f\n\r\t")`},
		{"other control chars", []any{"\x01\x1f"}, `F.b("\u0001\u001f")`},
		{"line separators stay literal", []any{"a b c"}, "F.b(\"a b c\")"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := core.BuildCacheKey("F.b", tc.args, nil); got != tc.want {
				t.Errorf("want %s\ngot  %s", tc.want, got)
			}
		})
	}
}

func TestBuildCacheKeyE_NonFiniteFloatsError(t *testing.T) {
	type price float64

	cases := []struct {
		name string
		arg  any
	}{
		{"NaN", math.NaN()},
		{"+Inf", math.Inf(1)},
		{"-Inf", math.Inf(-1)},
		{"float32 NaN", float32(math.NaN())},
		{"named float NaN", price(math.NaN())},
		{"nested in slice", []any{1, math.NaN()}},
		{"nested in map", map[string]any{"p": math.Inf(1)}},
		{"struct field", struct{ P float64 }{math.NaN()}},
		{"pointer", func() *float64 { f := math.NaN(); return &f }()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, err := core.BuildCacheKeyE("F.b", []any{tc.arg}, nil)
			if !errors.Is(err, core.ErrNonFiniteCacheArg) {
				t.Fatalf("want ErrNonFiniteCacheArg, got key=%q err=%v", key, err)
			}
			if key != "" {
				t.Errorf("want empty key on error, got %q", key)
			}
		})
	}

	t.Run("kwarg", func(t *testing.T) {
		_, err := core.BuildCacheKeyE("F.b", nil, map[string]any{"k": math.NaN()})
		if !errors.Is(err, core.ErrNonFiniteCacheArg) {
			t.Fatalf("want ErrNonFiniteCacheArg, got %v", err)
		}
	})

	t.Run("finite values succeed", func(t *testing.T) {
		key, err := core.BuildCacheKeyE("F.b", []any{1.5, "NaN"}, nil)
		if err != nil || key != `F.b(1.5,"NaN")` {
			t.Fatalf("got key=%q err=%v", key, err)
		}
	})
}

func TestBuildCacheKey_NonFiniteFloatPanics(t *testing.T) {
	defer func() {
		r := recover()
		err, ok := r.(error)
		if !ok || !errors.Is(err, core.ErrNonFiniteCacheArg) {
			t.Fatalf("want panic wrapping ErrNonFiniteCacheArg, got %v", r)
		}
	}()
	core.BuildCacheKey("F.b", []any{math.NaN()}, nil)
}

type failingCacheAdapter struct {
	getErr error
	setErr error
	gets   int
	sets   int
}

func (a *failingCacheAdapter) Get(context.Context, string) (any, error) {
	a.gets++
	if a.getErr != nil {
		return nil, a.getErr
	}
	return nil, core.ErrCacheMiss
}

func (a *failingCacheAdapter) Set(context.Context, string, any, time.Duration) error {
	a.sets++
	return a.setErr
}

func TestCache_NonFiniteArgErrorsBeforeAdapterAndFn(t *testing.T) {
	adapter := &failingCacheAdapter{}
	calls := 0
	price := core.Cache[float64, float64](adapter, "Svc.price", time.Minute,
		func(_ context.Context, in float64) (float64, error) {
			calls++
			return in, nil
		})

	_, err := price(context.Background(), math.NaN())
	if !errors.Is(err, core.ErrNonFiniteCacheArg) {
		t.Fatalf("want ErrNonFiniteCacheArg, got %v", err)
	}
	if calls != 0 || adapter.gets != 0 || adapter.sets != 0 {
		t.Errorf("want no fn/adapter calls, got fn=%d gets=%d sets=%d", calls, adapter.gets, adapter.sets)
	}
}

func TestCache_SetFailureFailsOpen(t *testing.T) {
	adapter := &failingCacheAdapter{setErr: errors.New("redis down")}
	calls := 0
	pay := core.Cache[struct{}, string](adapter, "Svc.pay", time.Minute,
		func(context.Context, struct{}) (string, error) {
			calls++
			return "paid", nil
		})

	got, err := pay(context.Background(), struct{}{})
	if err != nil || got != "paid" {
		t.Fatalf("want (paid, nil), got (%q, %v)", got, err)
	}
	if calls != 1 || adapter.sets != 1 {
		t.Errorf("want fn=1 sets=1, got fn=%d sets=%d", calls, adapter.sets)
	}
}

func TestCache_GetFailureFailsClosed(t *testing.T) {
	down := errors.New("redis down")
	adapter := &failingCacheAdapter{getErr: down}
	calls := 0
	pay := core.Cache[struct{}, string](adapter, "Svc.pay", time.Minute,
		func(context.Context, struct{}) (string, error) {
			calls++
			return "paid", nil
		})

	got, err := pay(context.Background(), struct{}{})
	if !errors.Is(err, down) || got != "" {
		t.Fatalf("want (\"\", redis down), got (%q, %v)", got, err)
	}
	if calls != 0 || adapter.sets != 0 {
		t.Errorf("want fn=0 sets=0, got fn=%d sets=%d", calls, adapter.sets)
	}
}

func TestBuildCacheKeyE_NonFiniteJSONNumberErrors(t *testing.T) {
	tokens := []string{"NaN", "nan", "Inf", "+Inf", "-Inf", "Infinity", "-Infinity"}
	for _, tok := range tokens {
		t.Run(tok, func(t *testing.T) {
			num := json.Number(tok)
			shapes := []struct {
				name   string
				args   []any
				kwargs map[string]any
			}{
				{"top-level", []any{num}, nil},
				{"inside-slice", []any{[]any{num}}, nil},
				{"map-value", []any{map[string]any{"k": num}}, nil},
				{"kwarg-value", nil, map[string]any{"k": num}},
			}
			for _, s := range shapes {
				t.Run(s.name, func(t *testing.T) {
					key, err := core.BuildCacheKeyE("F.b", s.args, s.kwargs)
					if !errors.Is(err, core.ErrNonFiniteCacheArg) {
						t.Fatalf("want ErrNonFiniteCacheArg, got key=%q err=%v", key, err)
					}
					if key != "" {
						t.Errorf("want empty key on error, got %q", key)
					}
				})
			}
		})
	}
}

func TestBuildCacheKeyE_FiniteJSONNumberUnchanged(t *testing.T) {
	cases := []struct {
		in   json.Number
		want string
	}{
		{json.Number("42"), "F.b(42)"},
		{json.Number("1.50"), "F.b(1.50)"},
		{json.Number("1e999"), "F.b(1e999)"},
	}
	for _, tc := range cases {
		t.Run(string(tc.in), func(t *testing.T) {
			key, err := core.BuildCacheKeyE("F.b", []any{tc.in}, nil)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if key != tc.want {
				t.Fatalf("want %s, got %s", tc.want, key)
			}
		})
	}
}

func TestBuildCacheKeyE_NonFiniteMapKeyErrors(t *testing.T) {
	type price float64

	cases := []struct {
		name string
		arg  any
	}{
		{"map[float64]int NaN", map[float64]int{math.NaN(): 1}},
		{"map[float64]int +Inf", map[float64]int{math.Inf(1): 1}},
		{"map[float64]int -Inf", map[float64]int{math.Inf(-1): 1}},
		{"map[float32]string NaN32", map[float32]string{float32(math.NaN()): "x"}},
		{"named type price NaN", map[price]int{price(math.NaN()): 1}},
		{"map[any]int NaN", map[any]int{math.NaN(): 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				key string
				err error
			)
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("unexpected panic: %v", r)
					}
				}()
				key, err = core.BuildCacheKeyE("F.b", []any{tc.arg}, nil)
			}()
			if !errors.Is(err, core.ErrNonFiniteCacheArg) {
				t.Fatalf("want ErrNonFiniteCacheArg, got key=%q err=%v", key, err)
			}
			if key != "" {
				t.Errorf("want empty key on error, got %q", key)
			}
		})
	}
}

func TestBuildCacheKeyE_FiniteFloatMapKeyUnchanged(t *testing.T) {
	key, err := core.BuildCacheKeyE("F.b", []any{map[float64]int{1.5: 1}}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := `F.b({"1.5":1})`
	if key != want {
		t.Fatalf("want %s, got %s", want, key)
	}
}

func reviveNonFinite(v any) any {
	switch val := v.(type) {
	case map[string]any:
		if len(val) == 1 {
			if token, ok := val["$nonfinite"].(string); ok {
				switch token {
				case "NaN":
					return math.NaN()
				case "Infinity":
					return math.Inf(1)
				case "-Infinity":
					return math.Inf(-1)
				}
			}
		}
		out := make(map[string]any, len(val))
		for k, elem := range val {
			out[k] = reviveNonFinite(elem)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, elem := range val {
			out[i] = reviveNonFinite(elem)
		}
		return out
	default:
		return v
	}
}

func TestBuildCacheKeyE_SharedRejectionFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "contracts", "fixtures", "cache-key.errors.examples.json")
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		fixturePath = filepath.Join("contracts", "fixtures", "cache-key.errors.examples.json")
		data, err = os.ReadFile(fixturePath)
		if err != nil {
			t.Fatalf("failed to read fixture file: %v", err)
		}
	}

	var fixture struct {
		Examples []struct {
			Name     string         `json:"name"`
			Qualname string         `json:"qualname"`
			Args     []any          `json:"args"`
			Kwargs   map[string]any `json:"kwargs"`
		} `json:"examples"`
	}

	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("failed to unmarshal fixture: %v", err)
	}

	if len(fixture.Examples) < 8 {
		t.Fatalf("expected at least 8 examples, got %d", len(fixture.Examples))
	}

	for _, ex := range fixture.Examples {
		t.Run(ex.Name, func(t *testing.T) {
			revivedArgs := reviveNonFinite(ex.Args).([]any)
			var revivedKwargs map[string]any
			if ex.Kwargs != nil {
				revivedKwargs = reviveNonFinite(ex.Kwargs).(map[string]any)
			}
			key, err := core.BuildCacheKeyE(ex.Qualname, revivedArgs, revivedKwargs)
			if !errors.Is(err, core.ErrNonFiniteCacheArg) {
				t.Fatalf("want ErrNonFiniteCacheArg, got key=%q err=%v", key, err)
			}
			if key != "" {
				t.Fatalf("want empty key on error, got %q", key)
			}
		})
	}
}

func TestBuildCacheKeyE_NonFiniteJSONNumberHiddenInStructErrors(t *testing.T) {
	type holder struct {
		N json.Number
		P *json.Number
	}
	nan := json.Number("NaN")
	cases := map[string]any{
		"struct field":        holder{N: "NaN"},
		"pointer field":       holder{N: "1", P: &nan},
		"slice of structs":    []holder{{N: "-Infinity"}},
		"pointer to struct":   &holder{N: "Inf"},
		"json.Number map key": map[json.Number]int{"NaN": 1},
		"nested in map value": map[string]any{"a": []any{holder{N: "NaN"}}},
		"struct in struct":    struct{ H holder }{H: holder{N: "NaN"}},
		"non-finite in slice": struct{ Ns []json.Number }{Ns: []json.Number{"1", "NaN"}},
		"non-finite in a map": struct{ M map[string]json.Number }{M: map[string]json.Number{"a": "NaN"}},
		"invalid plus NaN":    struct{ A, B json.Number }{A: "abc", B: "NaN"},
		"float beside invalid": struct {
			A json.Number
			F float64
		}{A: "abc", F: math.Inf(1)},
	}
	for name, arg := range cases {
		t.Run(name, func(t *testing.T) {
			key, err := core.BuildCacheKeyE("F.b", []any{arg}, nil)
			if !errors.Is(err, core.ErrNonFiniteCacheArg) || key != "" {
				t.Fatalf("want ErrNonFiniteCacheArg, got key=%q err=%v", key, err)
			}
		})
	}
}

func TestBuildCacheKeyE_FiniteJSONNumberStructUnchanged(t *testing.T) {
	type holder struct {
		N json.Number
		P *json.Number
	}
	key, err := core.BuildCacheKeyE("F.b", []any{holder{N: "1"}}, nil)
	if err != nil || key != `F.b({"N":1,"P":null})` {
		t.Fatalf("got key=%q err=%v", key, err)
	}
	// An invalid (but not non-finite) literal still falls back to the string form.
	key, err = core.BuildCacheKeyE("F.b", []any{holder{N: "abc"}}, nil)
	if err != nil || key != `F.b("{abc <nil>}")` {
		t.Fatalf("got key=%q err=%v", key, err)
	}
}

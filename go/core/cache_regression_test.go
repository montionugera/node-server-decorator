package core_test

import (
	"context"
	"errors"
	"math"
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

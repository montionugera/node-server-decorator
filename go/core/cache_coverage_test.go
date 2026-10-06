package core_test

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

// cacheCovAdapter is a scriptable CacheAdapter: getFn decides what a read returns and every
// write is recorded.
type cacheCovAdapter struct {
	getFn   func(key string) (any, error)
	setErr  error
	getKeys []string
	sets    []cacheCovSet
}

type cacheCovSet struct {
	key string
	val any
	ttl time.Duration
}

func (a *cacheCovAdapter) Get(_ context.Context, key string) (any, error) {
	a.getKeys = append(a.getKeys, key)
	return a.getFn(key)
}

func (a *cacheCovAdapter) Set(_ context.Context, key string, val any, ttl time.Duration) error {
	a.sets = append(a.sets, cacheCovSet{key, val, ttl})
	return a.setErr
}

func cacheCovMiss(string) (any, error) { return nil, core.ErrCacheMiss }

type cacheCovQuery struct {
	Tenant string
	Page   int
	// Trace must not influence the cache key.
	Trace string
}

func (q cacheCovQuery) CacheKeyArgs() ([]any, map[string]any) {
	return []any{q.Tenant}, map[string]any{"page": q.Page}
}

type cacheCovUser struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

func TestCacheCoverage_KeyArgsProviderControlsTheKey(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: cacheCovMiss}
	cached := core.Cache(adapter, "Svc.list", time.Minute, func(_ context.Context, q cacheCovQuery) (int, error) {
		return q.Page * 10, nil
	})

	got, err := cached(context.Background(), cacheCovQuery{Tenant: "acme", Page: 3, Trace: "t-1"})
	if err != nil || got != 30 {
		t.Fatalf("got (%d, %v), want (30, nil)", got, err)
	}
	if _, err := cached(context.Background(), cacheCovQuery{Tenant: "acme", Page: 3, Trace: "t-2"}); err != nil {
		t.Fatal(err)
	}

	want, err := core.BuildCacheKeyE("Svc.list", []any{"acme"}, map[string]any{"page": 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(adapter.getKeys) != 2 || adapter.getKeys[0] != want || adapter.getKeys[1] != want {
		t.Errorf("keys = %v, want both %q (Trace must not affect the key)", adapter.getKeys, want)
	}
	if len(adapter.sets) != 2 || adapter.sets[0] != (cacheCovSet{want, 30, time.Minute}) {
		t.Errorf("sets = %+v, want key %q value 30 ttl 1m", adapter.sets, want)
	}
}

func TestCacheCoverage_SliceInputIsSpreadAsPositionalArgs(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: cacheCovMiss}
	cached := core.Cache(adapter, "Svc.sum", time.Second, func(_ context.Context, in []any) (int, error) {
		return len(in), nil
	})

	if got, err := cached(context.Background(), []any{"a", 2}); err != nil || got != 2 {
		t.Fatalf("got (%d, %v), want (2, nil)", got, err)
	}

	spread, _ := core.BuildCacheKeyE("Svc.sum", []any{"a", 2}, nil)
	nested, _ := core.BuildCacheKeyE("Svc.sum", []any{[]any{"a", 2}}, nil)
	if adapter.getKeys[0] != spread {
		t.Errorf("key = %q, want the spread-args key %q", adapter.getKeys[0], spread)
	}
	if spread == nested {
		t.Fatalf("test is vacuous: spread and nested keys are equal (%q)", spread)
	}
}

func TestCacheCoverage_EmptyStructInputMeansNoArgs(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: cacheCovMiss}
	cached := core.Cache(adapter, "Svc.all", time.Second, func(context.Context, struct{}) (string, error) {
		return "ok", nil
	})

	if got, err := cached(context.Background(), struct{}{}); err != nil || got != "ok" {
		t.Fatalf("got (%q, %v), want (ok, nil)", got, err)
	}
	want, _ := core.BuildCacheKeyE("Svc.all", []any{}, nil)
	if adapter.getKeys[0] != want {
		t.Errorf("key = %q, want the zero-arg key %q", adapter.getKeys[0], want)
	}
}

func TestCacheCoverage_CachedNilIsAHitReturningZero(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: func(string) (any, error) { return nil, nil }}
	calls := 0
	cached := core.Cache(adapter, "Svc.find", time.Second, func(context.Context, string) (*cacheCovUser, error) {
		calls++
		return &cacheCovUser{Name: "fresh"}, nil
	})

	got, err := cached(context.Background(), "u1")
	if err != nil || got != nil {
		t.Fatalf("got (%v, %v), want (nil, nil)", got, err)
	}
	if calls != 0 || len(adapter.sets) != 0 {
		t.Errorf("a cached nil must not re-run fn or write: calls=%d sets=%d", calls, len(adapter.sets))
	}
}

func TestCacheCoverage_SentinelValueIsAMissEvenWithoutError(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: func(string) (any, error) { return core.CacheMiss, nil }}
	calls := 0
	cached := core.Cache(adapter, "Svc.find", 5*time.Second, func(context.Context, string) (int, error) {
		calls++
		return 0, nil
	})

	got, err := cached(context.Background(), "u1")
	if err != nil || got != 0 {
		t.Fatalf("got (%d, %v), want (0, nil)", got, err)
	}
	if calls != 1 {
		t.Errorf("fn calls = %d, want 1", calls)
	}
	// A legitimate zero result is written to the cache.
	if len(adapter.sets) != 1 || adapter.sets[0].val != 0 || adapter.sets[0].ttl != 5*time.Second {
		t.Errorf("sets = %+v, want one write of 0 with ttl 5s", adapter.sets)
	}
}

func TestCacheCoverage_SerializedValueIsDecodedIntoOut(t *testing.T) {
	// An adapter backed by a JSON store hands back a generic map, not the Go struct.
	adapter := &cacheCovAdapter{getFn: func(string) (any, error) {
		return map[string]any{"name": "ada", "age": float64(36)}, nil
	}}
	calls := 0
	cached := core.Cache(adapter, "Svc.find", time.Second, func(context.Context, string) (cacheCovUser, error) {
		calls++
		return cacheCovUser{}, nil
	})

	got, err := cached(context.Background(), "u1")
	if err != nil {
		t.Fatal(err)
	}
	if got != (cacheCovUser{Name: "ada", Age: 36}) {
		t.Errorf("got %+v, want {ada 36}", got)
	}
	if calls != 0 {
		t.Errorf("fn calls = %d, want 0 on a hit", calls)
	}
}

func TestCacheCoverage_UndecodableCachedValueIsAnError(t *testing.T) {
	cases := map[string]any{
		"wrong JSON shape":    "not-a-number",
		"not JSON-encodable":  make(chan int),
		"object for a scalar": map[string]any{"a": 1},
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			adapter := &cacheCovAdapter{getFn: func(string) (any, error) { return value, nil }}
			calls := 0
			cached := core.Cache(adapter, "Svc.count", time.Second, func(context.Context, string) (int, error) {
				calls++
				return 7, nil
			})

			got, err := cached(context.Background(), "k")
			if err == nil || !strings.Contains(err.Error(), "cannot cast cached value") {
				t.Fatalf("err = %v, want a cast error", err)
			}
			if got != 0 {
				t.Errorf("got %d, want the zero value on error", got)
			}
			if calls != 0 || len(adapter.sets) != 0 {
				t.Errorf("a bad cached value must not fall through to fn: calls=%d sets=%d", calls, len(adapter.sets))
			}
		})
	}
}

func TestCacheCoverage_AdapterReadErrorIsReturnedWithoutCallingFn(t *testing.T) {
	boom := errors.New("redis down")
	adapter := &cacheCovAdapter{getFn: func(string) (any, error) { return nil, boom }}
	calls := 0
	cached := core.Cache(adapter, "Svc.count", time.Second, func(context.Context, string) (int, error) {
		calls++
		return 7, nil
	})

	got, err := cached(context.Background(), "k")
	if !errors.Is(err, boom) || got != 0 {
		t.Fatalf("got (%d, %v), want (0, redis down)", got, err)
	}
	if calls != 0 {
		t.Errorf("fn calls = %d, want 0", calls)
	}
}

func TestCacheCoverage_WrappedMissErrorIsStillAMiss(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: func(string) (any, error) {
		return nil, errors.Join(errors.New("adapter context"), core.ErrCacheMiss)
	}}
	cached := core.Cache(adapter, "Svc.count", time.Second, func(context.Context, string) (int, error) {
		return 7, nil
	})

	if got, err := cached(context.Background(), "k"); err != nil || got != 7 {
		t.Fatalf("got (%d, %v), want (7, nil)", got, err)
	}
	if len(adapter.sets) != 1 || adapter.sets[0].val != 7 {
		t.Errorf("sets = %+v, want one write of 7", adapter.sets)
	}
}

func TestCacheCoverage_WriteErrorFailsOpen(t *testing.T) {
	adapter := &cacheCovAdapter{getFn: cacheCovMiss, setErr: errors.New("write refused")}
	cached := core.Cache(adapter, "Svc.count", time.Second, func(context.Context, string) (int, error) {
		return 7, nil
	})

	if got, err := cached(context.Background(), "k"); err != nil || got != 7 {
		t.Fatalf("got (%d, %v), want (7, nil): a failed write must not fail the call", got, err)
	}
	if len(adapter.sets) != 1 {
		t.Errorf("Set calls = %d, want 1", len(adapter.sets))
	}
}

func TestCacheCoverage_FnErrorIsNotCached(t *testing.T) {
	boom := errors.New("db down")
	adapter := &cacheCovAdapter{getFn: cacheCovMiss}
	cached := core.Cache(adapter, "Svc.count", time.Second, func(context.Context, string) (int, error) {
		return 99, boom
	})

	got, err := cached(context.Background(), "k")
	if !errors.Is(err, boom) || got != 0 {
		t.Fatalf("got (%d, %v), want (0, db down)", got, err)
	}
	if len(adapter.sets) != 0 {
		t.Errorf("an error result must not be cached, sets = %+v", adapter.sets)
	}
}

func TestCacheCoverage_NonFiniteArgFailsBeforeTouchingAdapterOrFn(t *testing.T) {
	for name, in := range map[string]float64{"NaN": math.NaN(), "+Inf": math.Inf(1), "-Inf": math.Inf(-1)} {
		t.Run(name, func(t *testing.T) {
			adapter := &cacheCovAdapter{getFn: cacheCovMiss}
			calls := 0
			cached := core.Cache(adapter, "Svc.price", time.Second, func(context.Context, float64) (int, error) {
				calls++
				return 1, nil
			})

			got, err := cached(context.Background(), in)
			if !errors.Is(err, core.ErrNonFiniteCacheArg) || got != 0 {
				t.Fatalf("got (%d, %v), want (0, ErrNonFiniteCacheArg)", got, err)
			}
			if calls != 0 || len(adapter.getKeys) != 0 || len(adapter.sets) != 0 {
				t.Errorf("nothing may run for an unkeyable arg: calls=%d gets=%d sets=%d", calls, len(adapter.getKeys), len(adapter.sets))
			}
		})
	}
}

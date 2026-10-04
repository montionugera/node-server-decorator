package gqlloader_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/adapter/gqlloader"
	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

func gqlCovConfig(calls *int32, fail error) coalesce.Config[string, string] {
	return coalesce.Config[string, string]{
		Window: time.Millisecond,
		BatchFn: func(_ context.Context, keys []string) (map[string]string, error) {
			atomic.AddInt32(calls, 1)
			if fail != nil {
				return nil, fail
			}
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = "v:" + k
			}
			return out, nil
		},
	}
}

func TestForContextNilContextReturnsNil(t *testing.T) {
	var nilCtx context.Context
	if r := gqlloader.ForContext(nilCtx); r != nil {
		t.Fatalf("ForContext(nil) = %v, want nil", r)
	}
}

func TestForContextWithoutRegistryReturnsNil(t *testing.T) {
	if r := gqlloader.ForContext(context.Background()); r != nil {
		t.Fatalf("ForContext(background) = %v, want nil", r)
	}
}

func TestWithContextRoundTripsTheSameRegistry(t *testing.T) {
	reg := gqlloader.NewRegistry()
	ctx := gqlloader.WithContext(context.Background(), reg)
	if got := gqlloader.ForContext(ctx); got != reg {
		t.Fatalf("ForContext returned %p, want the attached registry %p", got, reg)
	}
	// A derived context still resolves to it.
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	if got := gqlloader.ForContext(child); got != reg {
		t.Fatal("derived context lost the registry")
	}
}

func TestGetOrCreateReusesLoaderPerName(t *testing.T) {
	reg := gqlloader.NewRegistry()
	var built, calls int32
	factory := func() *coalesce.Loader[string, string] {
		atomic.AddInt32(&built, 1)
		return coalesce.New(gqlCovConfig(&calls, nil))
	}

	a1 := gqlloader.GetOrCreate(reg, "a", factory)
	a2 := gqlloader.GetOrCreate(reg, "a", factory)
	b := gqlloader.GetOrCreate(reg, "b", factory)

	if a1 != a2 {
		t.Fatal("same name returned two different loaders")
	}
	if a1 == b {
		t.Fatal("different names shared one loader")
	}
	if built != 2 {
		t.Fatalf("factory ran %d times, want 2 (once per name)", built)
	}
}

func TestGetOrCreateReplacesLoaderOfDifferentType(t *testing.T) {
	reg := gqlloader.NewRegistry()
	var calls int32
	strLoader := gqlloader.GetOrCreate(reg, "shared", func() *coalesce.Loader[string, string] {
		return coalesce.New(gqlCovConfig(&calls, nil))
	})

	var intBuilt int32
	intFactory := func() *coalesce.Loader[int, int] {
		atomic.AddInt32(&intBuilt, 1)
		return coalesce.New(coalesce.Config[int, int]{
			Window: time.Millisecond,
			BatchFn: func(_ context.Context, keys []int) (map[int]int, error) {
				out := make(map[int]int, len(keys))
				for _, k := range keys {
					out[k] = k * k
				}
				return out, nil
			},
		})
	}
	intLoader := gqlloader.GetOrCreate(reg, "shared", intFactory)
	if intLoader == nil || intBuilt != 1 {
		t.Fatalf("type-mismatched name must build a new loader, built = %d", intBuilt)
	}
	if again := gqlloader.GetOrCreate(reg, "shared", intFactory); again != intLoader || intBuilt != 1 {
		t.Fatalf("second lookup with the new type should reuse it, built = %d", intBuilt)
	}

	v, err := intLoader.Load(context.Background(), 7)
	if err != nil || v != 49 {
		t.Fatalf("int loader Load(7) = (%d, %v), want (49, nil)", v, err)
	}
	// The displaced loader keeps working for whoever still holds it.
	s, err := strLoader.Load(context.Background(), "k")
	if err != nil || s != "v:k" {
		t.Fatalf("displaced loader Load(k) = (%q, %v)", s, err)
	}
}

func TestLoadWithoutRegistryFallsBackToStandaloneLoader(t *testing.T) {
	var calls int32
	cfg := gqlCovConfig(&calls, nil)

	for i := 0; i < 2; i++ {
		v, err := gqlloader.Load(context.Background(), "users", "k", cfg)
		if err != nil || v != "v:k" {
			t.Fatalf("Load = (%q, %v), want (v:k, nil)", v, err)
		}
	}
	if calls != 2 {
		t.Fatalf("BatchFn ran %d times, want 2: without a registry nothing is cached between calls", calls)
	}
}

func TestLoadWithRegistryRegistersLoaderUnderName(t *testing.T) {
	reg := gqlloader.NewRegistry()
	ctx := gqlloader.WithContext(context.Background(), reg)
	var calls int32

	v, err := gqlloader.Load(ctx, "users", "k", gqlCovConfig(&calls, nil))
	if err != nil || v != "v:k" {
		t.Fatalf("Load = (%q, %v), want (v:k, nil)", v, err)
	}

	var built int32
	gqlloader.GetOrCreate(reg, "users", func() *coalesce.Loader[string, string] {
		atomic.AddInt32(&built, 1)
		return coalesce.New(gqlCovConfig(&calls, nil))
	})
	if built != 0 {
		t.Fatal("Load did not register its loader in the request registry")
	}
}

func TestLoadPropagatesBatchError(t *testing.T) {
	boom := errors.New("db down")
	var calls int32

	_, err := gqlloader.Load(context.Background(), "users", "k", gqlCovConfig(&calls, boom))
	if !errors.Is(err, boom) {
		t.Fatalf("standalone Load err = %v, want db down", err)
	}

	ctx := gqlloader.WithContext(context.Background(), gqlloader.NewRegistry())
	v, err := gqlloader.Load(ctx, "users", "k", gqlCovConfig(&calls, boom))
	if !errors.Is(err, boom) || v != "" {
		t.Fatalf("registry Load = (%q, %v), want zero value and db down", v, err)
	}
}

func TestLoadHonoursCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg := coalesce.Config[string, string]{
		Window: 50 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	_, err := gqlloader.Load(ctx, "users", "k", cfg)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

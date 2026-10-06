package coalesce

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type mtctxKey string

const (
	mtctxTenantKey mtctxKey = "tenant"
)

// TestMultiTier_BatchFnSeesCallerContextValuesAndDeadline verifies that BatchFn
// receives request values and deadline from the caller's context.
func TestMultiTier_BatchFnSeesCallerContextValuesAndDeadline(t *testing.T) {
	var (
		mu          sync.Mutex
		gotVal      any
		gotDeadline time.Time
		gotHasDead  bool
	)
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 10 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			mu.Lock()
			gotVal = ctx.Value(mtctxTenantKey)
			gotDeadline, gotHasDead = ctx.Deadline()
			mu.Unlock()
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = "val-" + k
			}
			return out, nil
		},
	})
	defer loader.Close()

	parent := context.WithValue(context.Background(), mtctxTenantKey, "alice")
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()

	expectedDeadline, _ := ctx.Deadline()

	val, err := loader.Load(ctx, "k1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val != "val-k1" {
		t.Fatalf("expected val-k1, got %q", val)
	}

	mu.Lock()
	defer mu.Unlock()
	if gotVal != "alice" {
		t.Errorf("expected tenant alice, got %v", gotVal)
	}
	if !gotHasDead {
		t.Errorf("expected deadline to be present, but was not")
	} else if !gotDeadline.Equal(expectedDeadline) {
		t.Errorf("expected deadline %v, got %v", expectedDeadline, gotDeadline)
	}
}

type mtctxL2CacheFake struct {
	mu          sync.Mutex
	mgetVal     any
	setManyVal  any
	setManyDone chan struct{}
}

func newMtctxL2CacheFake() *mtctxL2CacheFake {
	return &mtctxL2CacheFake{
		setManyDone: make(chan struct{}, 1),
	}
}

func (c *mtctxL2CacheFake) MGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	c.mu.Lock()
	c.mgetVal = ctx.Value(mtctxTenantKey)
	c.mu.Unlock()
	return nil, nil
}

func (c *mtctxL2CacheFake) SetMany(ctx context.Context, items map[string][]byte, ttl time.Duration) error {
	c.mu.Lock()
	c.setManyVal = ctx.Value(mtctxTenantKey)
	c.mu.Unlock()
	select {
	case c.setManyDone <- struct{}{}:
	default:
	}
	return nil
}

func (c *mtctxL2CacheFake) Delete(ctx context.Context, keys ...string) error {
	return nil
}

// TestMultiTier_L2CacheSeesCallerContextValues verifies that L2Cache MGet and SetMany
// see request values from the caller's context.
func TestMultiTier_L2CacheSeesCallerContextValues(t *testing.T) {
	cache := newMtctxL2CacheFake()
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 10 * time.Millisecond,
		L2Cache:      cache,
		Serialize: func(s string) ([]byte, error) {
			return []byte(s), nil
		},
		Deserialize: func(b []byte) (string, error) {
			return string(b), nil
		},
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = "val-" + k
			}
			return out, nil
		},
	})
	defer loader.Close()

	ctx := context.WithValue(context.Background(), mtctxTenantKey, "alice")
	val, err := loader.Load(ctx, "k1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val != "val-k1" {
		t.Fatalf("expected val-k1, got %q", val)
	}

	select {
	case <-cache.setManyDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SetMany")
	}

	cache.mu.Lock()
	mgetVal := cache.mgetVal
	setManyVal := cache.setManyVal
	cache.mu.Unlock()

	if mgetVal != "alice" {
		t.Errorf("MGet expected tenant alice, got %v", mgetVal)
	}
	if setManyVal != "alice" {
		t.Errorf("SetMany expected tenant alice, got %v", setManyVal)
	}
}

// TestMultiTier_BatchUsesLatestDeadlineAndNoneWhenACallerIsUnbounded verifies deadline propagation
// among multiple callers joining the same batch window.
func TestMultiTier_BatchUsesLatestDeadlineAndNoneWhenACallerIsUnbounded(t *testing.T) {
	t.Run("LatestDeadline", func(t *testing.T) {
		var (
			mu        sync.Mutex
			gotDead   time.Time
			hasDead   bool
			batchKeys []string
		)
		loader := NewMultiTierLoader(MultiTierConfig[string, string]{
			BatchTimeout: 40 * time.Millisecond,
			BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
				mu.Lock()
				gotDead, hasDead = ctx.Deadline()
				batchKeys = append([]string(nil), keys...)
				mu.Unlock()
				out := make(map[string]string, len(keys))
				for _, k := range keys {
					out[k] = "val-" + k
				}
				return out, nil
			},
		})
		defer loader.Close()

		d1 := time.Now().Add(200 * time.Millisecond)
		d2 := time.Now().Add(2 * time.Second)
		ctx1, cancel1 := context.WithDeadline(context.Background(), d1)
		defer cancel1()
		ctx2, cancel2 := context.WithDeadline(context.Background(), d2)
		defer cancel2()

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = loader.Load(ctx1, "k1")
		}()
		go func() {
			defer wg.Done()
			_, _ = loader.Load(ctx2, "k2")
		}()

		// Wait until both callers join the active batch
		deadline := time.Now().Add(time.Second)
		for {
			loader.mu.Lock()
			joined := loader.activeBatch != nil && len(loader.activeBatch.keys) == 2
			loader.mu.Unlock()
			if joined || time.Now().After(deadline) {
				break
			}
			time.Sleep(time.Millisecond)
		}

		wg.Wait()

		mu.Lock()
		defer mu.Unlock()
		if len(batchKeys) != 2 {
			t.Fatalf("expected 2 keys in batch, got %v", batchKeys)
		}
		expectedDeadline, _ := ctx2.Deadline()
		if !hasDead {
			t.Fatalf("expected deadline to be present, but was not")
		}
		if !gotDead.Equal(expectedDeadline) {
			t.Fatalf("expected deadline %v, got %v", expectedDeadline, gotDead)
		}
	})

	t.Run("UnboundedWhenAnyCallerUnbounded", func(t *testing.T) {
		var (
			mu        sync.Mutex
			gotDead   time.Time
			hasDead   bool
			batchKeys []string
		)
		loader := NewMultiTierLoader(MultiTierConfig[string, string]{
			BatchTimeout: 40 * time.Millisecond,
			BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
				mu.Lock()
				gotDead, hasDead = ctx.Deadline()
				batchKeys = append([]string(nil), keys...)
				mu.Unlock()
				out := make(map[string]string, len(keys))
				for _, k := range keys {
					out[k] = "val-" + k
				}
				return out, nil
			},
		})
		defer loader.Close()

		ctx1, cancel1 := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel1()
		ctx2 := context.Background()

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = loader.Load(ctx1, "k1")
		}()
		go func() {
			defer wg.Done()
			_, _ = loader.Load(ctx2, "k2")
		}()

		// Wait until both callers join the active batch
		deadline := time.Now().Add(time.Second)
		for {
			loader.mu.Lock()
			joined := loader.activeBatch != nil && len(loader.activeBatch.keys) == 2
			loader.mu.Unlock()
			if joined || time.Now().After(deadline) {
				break
			}
			time.Sleep(time.Millisecond)
		}

		wg.Wait()

		mu.Lock()
		defer mu.Unlock()
		if len(batchKeys) != 2 {
			t.Fatalf("expected 2 keys in batch, got %v", batchKeys)
		}
		if hasDead {
			t.Fatalf("expected no deadline when a caller is unbounded, but got %v", gotDead)
		}
	})
}

// TestMultiTier_OpeningCallerCancelDoesNotCancelBatchForOthers verifies that when caller A
// opens the batch and cancels its context, caller B in the same batch receives its value
// and BatchFn context is not cancelled while running.
func TestMultiTier_OpeningCallerCancelDoesNotCancelBatchForOthers(t *testing.T) {
	var (
		mu            sync.Mutex
		batchFnCtxErr error
		batchKeys     []string
	)
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 50 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			mu.Lock()
			batchFnCtxErr = ctx.Err()
			batchKeys = append([]string(nil), keys...)
			mu.Unlock()
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = "val-" + k
			}
			return out, nil
		},
	})
	defer loader.Close()

	ctxA, cancelA := context.WithCancel(context.Background())
	ctxB := context.Background()

	var (
		valA string
		errA error
		valB string
		errB error
		wg   sync.WaitGroup
	)

	wg.Add(2)
	go func() {
		defer wg.Done()
		valA, errA = loader.Load(ctxA, "keyA")
	}()

	// Wait until caller A creates the active batch
	deadline := time.Now().Add(time.Second)
	for {
		loader.mu.Lock()
		hasA := loader.activeBatch != nil && loader.activeBatch.keyMap["keyA"]
		loader.mu.Unlock()
		if hasA || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}

	go func() {
		defer wg.Done()
		valB, errB = loader.Load(ctxB, "keyB")
	}()

	// Wait until caller B also joins the batch
	deadline = time.Now().Add(time.Second)
	for {
		loader.mu.Lock()
		hasBoth := loader.activeBatch != nil && loader.activeBatch.keyMap["keyA"] && loader.activeBatch.keyMap["keyB"]
		loader.mu.Unlock()
		if hasBoth || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}

	// Cancel caller A while caller B is in the batch
	cancelA()

	wg.Wait()

	if !errors.Is(errA, context.Canceled) {
		t.Fatalf("caller A: expected context.Canceled, got %v (val=%q)", errA, valA)
	}
	if errB != nil {
		t.Fatalf("caller B: unexpected error: %v", errB)
	}
	if valB != "val-keyB" {
		t.Fatalf("caller B: expected val-keyB, got %q", valB)
	}

	mu.Lock()
	defer mu.Unlock()
	if batchFnCtxErr != nil {
		t.Fatalf("BatchFn context was cancelled: %v", batchFnCtxErr)
	}
	if len(batchKeys) != 2 {
		t.Fatalf("expected 2 keys in batch, got %v", batchKeys)
	}
}

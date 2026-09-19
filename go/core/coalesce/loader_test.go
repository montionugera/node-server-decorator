package coalesce_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

func TestLoaderBatching(t *testing.T) {
	var batchCalls int32

	batchFn := func(ctx context.Context, keys []string) (map[string]string, error) {
		atomic.AddInt32(&batchCalls, 1)
		res := make(map[string]string)
		for _, k := range keys {
			res[k] = "val:" + k
		}
		return res, nil
	}

	loader := coalesce.New(coalesce.Config[string, string]{
		BatchFn:      batchFn,
		Window:       5 * time.Millisecond,
		MaxBatchSize: 100,
	})

	const numCallers = 50
	var wg sync.WaitGroup
	wg.Add(numCallers)

	for i := 0; i < numCallers; i++ {
		key := "user"
		go func(id int) {
			defer wg.Done()
			val, err := loader.Load(context.Background(), key)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if val != "val:"+key {
				t.Errorf("got %q, want %q", val, "val:"+key)
			}
		}(i)
	}

	wg.Wait()

	calls := atomic.LoadInt32(&batchCalls)
	if calls != 1 {
		t.Fatalf("expected 1 batch call, got %d", calls)
	}
}

func TestLoaderSingleFlightDeduplication(t *testing.T) {
	var executedKeys []string
	var mu sync.Mutex

	batchFn := func(ctx context.Context, keys []string) (map[string]string, error) {
		mu.Lock()
		executedKeys = append(executedKeys, keys...)
		mu.Unlock()

		res := make(map[string]string)
		for _, k := range keys {
			res[k] = "res:" + k
		}
		return res, nil
	}

	loader := coalesce.New(coalesce.Config[string, string]{
		BatchFn:      batchFn,
		Window:       5 * time.Millisecond,
		MaxBatchSize: 100,
		SingleFlight: true,
	})

	const numCallers = 20
	var wg sync.WaitGroup
	wg.Add(numCallers)

	for i := 0; i < numCallers; i++ {
		go func() {
			defer wg.Done()
			val, err := loader.Load(context.Background(), "same-key")
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if val != "res:same-key" {
				t.Errorf("got %q, want %q", val, "res:same-key")
			}
		}()
	}

	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(executedKeys) != 1 {
		t.Fatalf("expected exactly 1 deduplicated key in batch, got %d (%v)", len(executedKeys), executedKeys)
	}
}

func TestLoaderContextCancellationIsolation(t *testing.T) {
	batchFn := func(ctx context.Context, keys []string) (map[string]string, error) {
		time.Sleep(20 * time.Millisecond)
		res := make(map[string]string)
		for _, k := range keys {
			res[k] = "val:" + k
		}
		return res, nil
	}

	loader := coalesce.New(coalesce.Config[string, string]{
		BatchFn:      batchFn,
		Window:       5 * time.Millisecond,
		MaxBatchSize: 100,
	})

	ctxCancelled, cancel := context.WithCancel(context.Background())
	ctxNormal := context.Background()

	var wg sync.WaitGroup
	wg.Add(2)

	var errCancelled, errNormal error
	var valNormal string

	// Caller 1: Cancelled immediately
	go func() {
		defer wg.Done()
		_, errCancelled = loader.Load(ctxCancelled, "key1")
	}()

	// Caller 2: Normal
	go func() {
		defer wg.Done()
		valNormal, errNormal = loader.Load(ctxNormal, "key2")
	}()

	// Cancel caller 1 after batch is queued
	time.Sleep(2 * time.Millisecond)
	cancel()

	wg.Wait()

	if !errors.Is(errCancelled, context.Canceled) {
		t.Fatalf("expected context.Canceled for caller 1, got %v", errCancelled)
	}

	if errNormal != nil {
		t.Fatalf("expected caller 2 to succeed despite caller 1 cancellation, got %v", errNormal)
	}
	if valNormal != "val:key2" {
		t.Errorf("got %q, want %q", valNormal, "val:key2")
	}
}

func TestLoaderPrime(t *testing.T) {
	var batchCalls int32
	batchFn := func(ctx context.Context, keys []string) (map[string]string, error) {
		atomic.AddInt32(&batchCalls, 1)
		return nil, errors.New("should not be called")
	}

	loader := coalesce.New(coalesce.Config[string, string]{
		BatchFn: batchFn,
	})

	loader.Prime("cached-key", "preloaded-val")

	val, err := loader.Load(context.Background(), "cached-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if val != "preloaded-val" {
		t.Errorf("got %q, want %q", val, "preloaded-val")
	}

	if atomic.LoadInt32(&batchCalls) != 0 {
		t.Errorf("batchFn was called for primed key")
	}
}

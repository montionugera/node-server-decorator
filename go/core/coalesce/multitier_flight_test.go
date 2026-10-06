package coalesce

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMultiTier_CancelledBatchDoesNotFailLaterBatchSharingTheFlight(t *testing.T) {
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	var calls int32

	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 1 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			atomic.AddInt32(&calls, 1)
			select {
			case started <- struct{}{}:
			default:
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				out := make(map[string]string, len(keys))
				for _, k := range keys {
					out[k] = "v-" + k
				}
				return out, nil
			}
		},
	})
	defer loader.Close()

	ctxA, cancelA := context.WithCancel(context.Background())
	aDone := make(chan error, 1)
	go func() {
		_, err := loader.Load(ctxA, "k")
		aDone <- err
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for batch 1 to start")
	}

	type result struct {
		val string
		err error
	}
	bDone := make(chan result, 1)
	go func() {
		val, err := loader.Load(context.Background(), "k")
		bDone <- result{val: val, err: err}
	}()

	// Caller B must be waiting on batch 1's flight before A is cancelled, otherwise it would
	// simply lead a flight of its own and the retry path would go unexercised.
	deadline := time.Now().Add(2 * time.Second)
	for {
		joined := false
		loader.sf.mu.Lock()
		for _, c := range loader.sf.m {
			joined = joined || c.dups == 1
		}
		loader.sf.mu.Unlock()
		if joined {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for caller B's batch to join batch 1's flight")
		}
		time.Sleep(time.Millisecond)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("expected caller B to share batch 1's BatchFn call, got %d calls", n)
	}

	cancelA()
	select {
	case err := <-aDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("caller A: expected context.Canceled, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for caller A")
	}

	close(release)

	select {
	case r := <-bDone:
		if r.err != nil {
			t.Fatalf("caller B: expected nil error, got %v", r.err)
		}
		if r.val != "v-k" {
			t.Fatalf("caller B: expected v-k, got %q", r.val)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for caller B")
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("expected caller B to retry with exactly one BatchFn call of its own, got %d calls", n)
	}
}

type clearTestStore struct {
	mu      sync.Mutex
	db      map[string]string
	calls   int32
	started chan struct{}
	release chan struct{}
}

func (s *clearTestStore) set(k, v string) {
	s.mu.Lock()
	s.db[k] = v
	s.mu.Unlock()
}

func (s *clearTestStore) batch(ctx context.Context, keys []string) (map[string]string, error) {
	callNum := atomic.AddInt32(&s.calls, 1)
	s.mu.Lock()
	snapshot := make(map[string]string, len(keys))
	for _, k := range keys {
		if v, ok := s.db[k]; ok {
			snapshot[k] = v
		}
	}
	s.mu.Unlock()

	if callNum == 1 {
		select {
		case s.started <- struct{}{}:
		default:
		}
		select {
		case <-s.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return snapshot, nil
}

func TestMultiTier_ReadAfterClearDoesNotJoinPreClearFlight(t *testing.T) {
	store := &clearTestStore{
		db:      map[string]string{"k": "old"},
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	cache := newMockCache()
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 1 * time.Millisecond,
		L2Cache:      cache,
		BatchFn:      store.batch,
		Serialize:    func(v string) ([]byte, error) { return json.Marshal(v) },
		Deserialize: func(b []byte) (string, error) {
			var v string
			err := json.Unmarshal(b, &v)
			return v, err
		},
	})
	defer loader.Close()

	ctx := context.Background()
	aDone := make(chan string, 1)
	go func() {
		v, _ := loader.Load(ctx, "k")
		aDone <- v
	}()

	select {
	case <-store.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first read")
	}

	store.set("k", "new")
	if err := loader.Clear(ctx, "k"); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	type result struct {
		val string
		err error
	}
	bDone := make(chan result, 1)
	go func() {
		v, err := loader.Load(ctx, "k")
		bDone <- result{val: v, err: err}
	}()

	select {
	case r := <-bDone:
		if r.err != nil {
			t.Fatalf("caller B: unexpected error %v", r.err)
		}
		if r.val != "new" {
			t.Fatalf("caller B: expected new, got %q", r.val)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("caller B timed out (likely joined flight 1 before clear was released)")
	}

	close(store.release)
	select {
	case vA := <-aDone:
		if vA != "old" {
			t.Fatalf("caller A: expected old, got %q", vA)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("caller A timed out")
	}

	time.Sleep(20 * time.Millisecond)

	vPost, err := loader.Load(ctx, "k")
	if err != nil || vPost != "new" {
		t.Fatalf("further Load: expected new, got %q, err=%v", vPost, err)
	}

	if holder, ok := loader.l1.Get("k"); ok && holder.value == "old" {
		t.Fatalf("loader.l1 holds stale old value: %+v", holder)
	}
	cache.mu.Lock()
	raw, inL2 := cache.data["k"]
	cache.mu.Unlock()
	if inL2 {
		var decoded string
		_ = json.Unmarshal(raw, &decoded)
		if decoded == "old" {
			t.Fatalf("mock L2 holds stale old value: %s", raw)
		}
	}
}

type ctxAwareMockCache struct {
	*mockMGetCache
}

func newCtxAwareMockCache() *ctxAwareMockCache {
	return &ctxAwareMockCache{mockMGetCache: newMockCache()}
}

func (c *ctxAwareMockCache) MGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.mockMGetCache.MGet(ctx, keys)
}

func TestMultiTier_CancelledCallerDoesNotFailLateJoinerWithL2(t *testing.T) {
	cache := newCtxAwareMockCache()
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 80 * time.Millisecond,
		L2Cache:      cache,
		Serialize:    func(v string) ([]byte, error) { return json.Marshal(v) },
		Deserialize: func(b []byte) (string, error) {
			var v string
			err := json.Unmarshal(b, &v)
			return v, err
		},
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = "v-" + k
			}
			return out, nil
		},
	})
	defer loader.Close()

	ctxA, cancelA := context.WithCancel(context.Background())
	aDone := make(chan error, 1)
	go func() {
		_, err := loader.Load(ctxA, "a")
		aDone <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancelA()
	if err := <-aDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("caller A: expected context.Canceled, got %v", err)
	}

	// Still inside A's window.
	val, err := loader.Load(context.Background(), "b")
	if err != nil {
		t.Fatalf("caller B must not inherit A's cancellation, got %v", err)
	}
	if val != "v-b" {
		t.Fatalf("caller B: expected v-b, got %q", val)
	}
}

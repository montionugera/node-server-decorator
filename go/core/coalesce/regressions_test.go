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

// A caller that cancels inside the collection window must not poison the batch for a caller
// that joins the same window with a live context.
func TestMultiTier_CancelledCallerDoesNotFailLateJoiner(t *testing.T) {
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: 80 * time.Millisecond,
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

// The last waiter leaving an already dispatched batch still stops the query.
func TestMultiTier_AllCallersCancelledAfterDispatchCancelsBatch(t *testing.T) {
	cancelled := make(chan struct{})
	loader := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			select {
			case <-ctx.Done():
				close(cancelled)
				return nil, ctx.Err()
			case <-time.After(2 * time.Second):
				return map[string]string{}, nil
			}
		},
	})
	defer loader.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := loader.Load(ctx, "a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("batch context was not cancelled after its only caller left")
	}
}

func TestLoader_CancelledCallerDoesNotFailLateJoiner(t *testing.T) {
	loader := New(Config[string, string]{
		Window: 80 * time.Millisecond,
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

	val, err := loader.Load(context.Background(), "b")
	if err != nil || val != "v-b" {
		t.Fatalf("caller B: expected v-b, got %q err=%v", val, err)
	}
}

func TestLoader_SingleFlightFirstCallerCancelKeepsJoinedCaller(t *testing.T) {
	release := make(chan struct{})
	var calls int32
	loader := New(Config[string, string]{
		Window:       time.Millisecond,
		SingleFlight: true,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			atomic.AddInt32(&calls, 1)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return map[string]string{"k": "v"}, nil
		},
	})

	ctxA, cancelA := context.WithCancel(context.Background())
	aDone := make(chan error, 1)
	go func() {
		_, err := loader.Load(ctxA, "k")
		aDone <- err
	}()
	time.Sleep(20 * time.Millisecond)

	type res struct {
		val string
		err error
	}
	bDone := make(chan res, 1)
	go func() {
		v, err := loader.Load(context.Background(), "k")
		bDone <- res{v, err}
	}()
	time.Sleep(20 * time.Millisecond)

	cancelA()
	if err := <-aDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("caller A: expected context.Canceled, got %v", err)
	}
	close(release)

	select {
	case r := <-bDone:
		if r.err != nil || r.val != "v" {
			t.Fatalf("joined caller: expected v, got %q err=%v", r.val, r.err)
		}
	case <-time.After(time.Second):
		t.Fatal("joined caller never returned")
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("expected one shared batch call, got %d", n)
	}

	// A joined waiter honours its own deadline instead of blocking on the shared call.
	release2 := make(chan struct{})
	defer close(release2)
	slow := New(Config[string, string]{
		Window:       time.Millisecond,
		SingleFlight: true,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			<-release2
			return map[string]string{"k": "v"}, nil
		},
	})
	go func() { _, _ = slow.Load(context.Background(), "k") }()
	time.Sleep(10 * time.Millisecond)
	ctxC, cancelC := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelC()
	if _, err := slow.Load(ctxC, "k"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("joined waiter: expected its own deadline, got %v", err)
	}
}

// racingStore's batch function reads the row first and only then blocks, so the value it
// returns predates any invalidation issued while it is blocked.
type racingStore struct {
	mu      sync.Mutex
	db      map[string]string
	calls   int32
	started chan struct{}
	release chan struct{}
}

func newRacingStore(initial map[string]string) *racingStore {
	return &racingStore{db: initial, started: make(chan struct{}, 8), release: make(chan struct{}, 8)}
}

func (s *racingStore) set(k, v string) {
	s.mu.Lock()
	s.db[k] = v
	s.mu.Unlock()
}

func (s *racingStore) batch(ctx context.Context, keys []string) (map[string]string, error) {
	atomic.AddInt32(&s.calls, 1)
	s.mu.Lock()
	snapshot := make(map[string]string, len(keys))
	for _, k := range keys {
		if v, ok := s.db[k]; ok {
			snapshot[k] = v
		}
	}
	s.mu.Unlock()
	s.started <- struct{}{}
	<-s.release
	return snapshot, nil
}

func newRacingLoader(store *racingStore, cache MGetCache) *MultiTierLoader[string, string] {
	return NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchTimeout: time.Millisecond,
		L2Cache:      cache,
		BatchFn:      store.batch,
		Serialize:    func(v string) ([]byte, error) { return json.Marshal(v) },
		Deserialize: func(b []byte) (string, error) {
			var v string
			err := json.Unmarshal(b, &v)
			return v, err
		},
	})
}

func TestMultiTier_ClearDuringFlightDoesNotWriteBackStaleValue(t *testing.T) {
	store := newRacingStore(map[string]string{"k": "old"})
	cache := newMockCache()
	loader := newRacingLoader(store, cache)
	defer loader.Close()
	ctx := context.Background()

	first := make(chan string, 1)
	go func() {
		v, _ := loader.Load(ctx, "k")
		first <- v
	}()
	<-store.started // flight 1 has read "old" and is blocked

	store.set("k", "new")
	if err := loader.Clear(ctx, "k"); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	store.release <- struct{}{}
	if v := <-first; v != "old" {
		t.Fatalf("the read that began before the write keeps its value, got %q", v)
	}
	time.Sleep(20 * time.Millisecond) // let the stale flight finish its write-back phase

	if holder, ok := loader.l1.Get("k"); ok {
		t.Fatalf("stale value written back to L1 after Clear: %+v", holder)
	}
	cache.mu.Lock()
	raw, inL2 := cache.data["k"]
	cache.mu.Unlock()
	if inL2 {
		t.Fatalf("stale value written back to L2 after Clear: %s", raw)
	}

	store.release <- struct{}{}
	v, err := loader.Load(ctx, "k")
	if err != nil || v != "new" {
		t.Fatalf("read after clear: expected new, got %q err=%v", v, err)
	}
	if n := atomic.LoadInt32(&store.calls); n != 2 {
		t.Fatalf("expected a fresh batch call after Clear, got %d calls", n)
	}
}

func TestMultiTier_ClearDuringFlightDoesNotNegativeCache(t *testing.T) {
	store := newRacingStore(map[string]string{})
	loader := newRacingLoader(store, nil)
	defer loader.Close()
	ctx := context.Background()

	first := make(chan string, 1)
	go func() {
		v, _ := loader.Load(ctx, "k")
		first <- v
	}()
	<-store.started

	store.set("k", "created")
	if err := loader.Clear(ctx, "k"); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	store.release <- struct{}{}
	<-first
	time.Sleep(20 * time.Millisecond)

	store.release <- struct{}{}
	v, err := loader.Load(ctx, "k")
	if err != nil || v != "created" {
		t.Fatalf("expected created (not a stale negative entry), got %q err=%v", v, err)
	}
}

// Clear only affects the cleared key: other keys of the same flight are still cached.
func TestMultiTier_ClearDuringFlightKeepsOtherKeys(t *testing.T) {
	store := newRacingStore(map[string]string{"a": "A", "b": "B"})
	loader := newRacingLoader(store, nil)
	defer loader.Close()
	ctx := context.Background()

	done := make(chan struct{})
	go func() {
		_, _ = loader.LoadMany(ctx, []string{"a", "b"})
		close(done)
	}()
	<-store.started
	_ = loader.Clear(ctx, "a")
	store.release <- struct{}{}
	<-done
	time.Sleep(20 * time.Millisecond)

	if _, ok := loader.l1.Get("a"); ok {
		t.Fatal("cleared key a must not be cached")
	}
	if holder, ok := loader.l1.Get("b"); !ok || holder.value != "B" {
		t.Fatalf("untouched key b must still be cached, got %+v ok=%v", holder, ok)
	}
}

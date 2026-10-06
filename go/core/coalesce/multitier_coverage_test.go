package coalesce

import (
	"context"
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// mtCovL2 is an in-memory MGetCache whose every operation can be overridden.
type mtCovL2 struct {
	mu       sync.Mutex
	data     map[string][]byte
	mgetErr  error
	extra    map[string][]byte // returned by MGet in addition to the requested keys
	delErr   error
	mgets    [][]string
	sets     []map[string][]byte
	setTTLs  []time.Duration
	deletes  [][]string
	setErr   error
	setEvent chan struct{}
}

func newMtCovL2() *mtCovL2 {
	return &mtCovL2{data: map[string][]byte{}, setEvent: make(chan struct{}, 16)}
}

func (c *mtCovL2) MGet(_ context.Context, keys []string) (map[string][]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mgets = append(c.mgets, append([]string(nil), keys...))
	if c.mgetErr != nil {
		return nil, c.mgetErr
	}
	out := map[string][]byte{}
	for _, k := range keys {
		if v, ok := c.data[k]; ok {
			out[k] = v
		}
	}
	for k, v := range c.extra {
		out[k] = v
	}
	return out, nil
}

func (c *mtCovL2) SetMany(_ context.Context, items map[string][]byte, ttl time.Duration) error {
	c.mu.Lock()
	cp := make(map[string][]byte, len(items))
	for k, v := range items {
		cp[k] = v
		if c.setErr == nil {
			c.data[k] = v
		}
	}
	c.sets = append(c.sets, cp)
	c.setTTLs = append(c.setTTLs, ttl)
	err := c.setErr
	c.mu.Unlock()
	c.setEvent <- struct{}{}
	return err
}

func (c *mtCovL2) Delete(_ context.Context, keys ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.deletes = append(c.deletes, append([]string(nil), keys...))
	if c.delErr != nil {
		return c.delErr
	}
	for _, k := range keys {
		delete(c.data, k)
	}
	return nil
}

func (c *mtCovL2) mgetCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.mgets)
}

func (c *mtCovL2) setCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sets)
}

func (c *mtCovL2) waitSet(t *testing.T) {
	t.Helper()
	select {
	case <-c.setEvent:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for L2 SetMany")
	}
}

// mtCovDB is an L3 fake recording every batch.
type mtCovDB struct {
	mu      sync.Mutex
	rows    map[string]string
	err     error
	batches [][]string
}

func (d *mtCovDB) batch(_ context.Context, keys []string) (map[string]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	sorted := append([]string(nil), keys...)
	sort.Strings(sorted)
	d.batches = append(d.batches, sorted)
	if d.err != nil {
		return nil, d.err
	}
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := d.rows[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func (d *mtCovDB) calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.batches)
}

func mtCovSer(v string) ([]byte, error)   { return []byte("s:" + v), nil }
func mtCovDeser(b []byte) (string, error) { return string(b[2:]), nil }

func mtCovWaitActiveBatch[K comparable, V any](t *testing.T, l *MultiTierLoader[K, V], wantKeys int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		ready := l.activeBatch != nil && len(l.activeBatch.keys) >= wantKeys
		l.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no collecting batch with %d keys appeared", wantKeys)
}

func TestMultiTierConfigDefaults(t *testing.T) {
	l := NewMultiTierLoader(MultiTierConfig[int, string]{
		L1Capacity: -1, L1TTL: -1, L2TTL: -1, NegativeTTL: -1, MaxBatchSize: -1, BatchTimeout: -1,
	})
	defer l.Close()

	if l.cfg.L1Capacity != 10000 || l.cfg.L1TTL != 10*time.Second || l.cfg.L2TTL != 5*time.Minute ||
		l.cfg.NegativeTTL != 5*time.Second || l.cfg.MaxBatchSize != 100 || l.cfg.BatchTimeout != time.Millisecond {
		t.Fatalf("non-positive settings were not replaced by defaults: %+v", l.cfg)
	}
	if got := l.cfg.KeyToString(42); got != "42" {
		t.Fatalf("default KeyToString(42) = %q, want 42", got)
	}

	explicit := NewMultiTierLoader(MultiTierConfig[int, string]{
		L1Capacity: 3, L1TTL: time.Minute, L2TTL: time.Hour, NegativeTTL: 2 * time.Second,
		MaxBatchSize: 7, BatchTimeout: 9 * time.Millisecond,
		KeyToString: func(k int) string { return "custom" },
	})
	defer explicit.Close()
	if explicit.cfg.L1Capacity != 3 || explicit.cfg.L1TTL != time.Minute || explicit.cfg.L2TTL != time.Hour ||
		explicit.cfg.NegativeTTL != 2*time.Second || explicit.cfg.MaxBatchSize != 7 ||
		explicit.cfg.BatchTimeout != 9*time.Millisecond || explicit.cfg.KeyToString(1) != "custom" {
		t.Fatalf("explicit settings were overridden: %+v", explicit.cfg)
	}
}

func TestMultiTierLoadAfterCloseFails(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	l.Close()

	v, err := l.Load(context.Background(), "a")
	if err == nil || err.Error() != "loader is closed" || v != "" {
		t.Fatalf("Load after Close = (%q, %v), want zero value and \"loader is closed\"", v, err)
	}
	if db.calls() != 0 {
		t.Fatalf("BatchFn ran %d times on a closed loader", db.calls())
	}
}

func TestMultiTierCloseEmptiesL1(t *testing.T) {
	db := &mtCovDB{}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	l.Prime("a", "A")
	if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
		t.Fatalf("primed Load = (%q, %v)", v, err)
	}
	l.Close()
	if l.l1.Len() != 0 {
		t.Fatalf("L1 holds %d entries after Close, want 0", l.l1.Len())
	}
}

func TestMultiTierCloseFlushesCollectingBatch(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, BatchTimeout: time.Hour})

	type res struct {
		v   string
		err error
	}
	done := make(chan res, 1)
	go func() {
		v, err := l.Load(context.Background(), "a")
		done <- res{v, err}
	}()
	mtCovWaitActiveBatch(t, l, 1)
	l.Close()

	select {
	case r := <-done:
		if r.err != nil || r.v != "A" {
			t.Fatalf("pending Load = (%q, %v), want (A, nil) once Close dispatches the batch", r.v, r.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close left a waiting caller stuck behind the batch timer")
	}
	l.mu.Lock()
	active := l.activeBatch
	l.mu.Unlock()
	if active != nil {
		t.Fatal("activeBatch still set after Close")
	}
}

func TestMultiTierMaxBatchSizeDispatchesWithoutWaitingForTimer(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A", "b": "B"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, BatchTimeout: time.Hour, MaxBatchSize: 2})
	defer l.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got, err := l.LoadMany(ctx, []string{"a", "b"})
	if err != nil {
		t.Fatalf("LoadMany: %v (a full batch must dispatch immediately)", err)
	}
	if got["a"] != "A" || got["b"] != "B" || len(got) != 2 {
		t.Fatalf("LoadMany = %v", got)
	}
	if len(db.batches) != 1 || len(db.batches[0]) != 2 {
		t.Fatalf("batches = %v, want one batch with both keys", db.batches)
	}
}

func TestMultiTierTriggerBatchIsIdempotent(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	defer l.Close()

	req := &multiTierRequest[string]{result: make(chan string, 1), err: make(chan error, 1)}
	b := &multiTierBatch[string, string]{
		keys:        []string{"a"},
		keyMap:      map[string]bool{"a": true},
		requests:    map[string][]*multiTierRequest[string]{"a": {req}},
		ctx:         context.Background(),
		cancelBatch: func() {},
	}
	l.mu.Lock()
	l.triggerBatch(b)
	l.triggerBatch(b)
	l.mu.Unlock()

	select {
	case v := <-req.result:
		if v != "A" {
			t.Fatalf("result = %q, want A", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("batch never resolved")
	}
	time.Sleep(20 * time.Millisecond)
	if db.calls() != 1 {
		t.Fatalf("BatchFn ran %d times, want 1: a dispatched batch must not run twice", db.calls())
	}
	if len(req.result) != 0 {
		t.Fatal("request was resolved twice")
	}
}

func TestMultiTierBatchErrorReachesEveryCaller(t *testing.T) {
	boom := errors.New("db down")
	db := &mtCovDB{err: boom}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	defer l.Close()

	v, err := l.Load(context.Background(), "a")
	if !errors.Is(err, boom) || v != "" {
		t.Fatalf("Load = (%q, %v), want zero value and db down", v, err)
	}

	many, err := l.LoadMany(context.Background(), []string{"x", "y"})
	if !errors.Is(err, boom) || many != nil {
		t.Fatalf("LoadMany = (%v, %v), want (nil, db down)", many, err)
	}

	// Errors are not negatively cached: recovery is visible on the next load.
	db.mu.Lock()
	db.err, db.rows = nil, map[string]string{"a": "A"}
	db.mu.Unlock()
	if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
		t.Fatalf("Load after recovery = (%q, %v), want (A, nil)", v, err)
	}
}

func TestMultiTierLoadManyEmptyReturnsEmptyMap(t *testing.T) {
	db := &mtCovDB{}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	defer l.Close()

	for _, keys := range [][]string{nil, {}} {
		got, err := l.LoadMany(context.Background(), keys)
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("LoadMany(%v) = (%v, %v), want empty non-nil map", keys, got, err)
		}
	}
	if db.calls() != 0 {
		t.Fatalf("BatchFn ran %d times for empty input", db.calls())
	}
}

func TestMultiTierLoadManyDuplicateKeysQueryOnce(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, BatchTimeout: 20 * time.Millisecond})
	defer l.Close()

	got, err := l.LoadMany(context.Background(), []string{"a", "a", "a"})
	if err != nil || len(got) != 1 || got["a"] != "A" {
		t.Fatalf("LoadMany = (%v, %v)", got, err)
	}
	if len(db.batches) != 1 || len(db.batches[0]) != 1 {
		t.Fatalf("batches = %v, want one batch with the key de-duplicated", db.batches)
	}
}

func TestMultiTierMissingKeyIsNegativelyCached(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, NegativeTTL: 30 * time.Millisecond})
	defer l.Close()

	for i := 0; i < 3; i++ {
		v, err := l.Load(context.Background(), "ghost")
		if err != nil || v != "" {
			t.Fatalf("Load(ghost) #%d = (%q, %v), want zero value and no error", i, v, err)
		}
	}
	if db.calls() != 1 {
		t.Fatalf("BatchFn ran %d times, want 1 while the negative entry is live", db.calls())
	}

	time.Sleep(60 * time.Millisecond)
	db.mu.Lock()
	db.rows["ghost"] = "now-exists"
	db.mu.Unlock()
	if v, err := l.Load(context.Background(), "ghost"); err != nil || v != "now-exists" {
		t.Fatalf("Load after NegativeTTL = (%q, %v), want the newly created row", v, err)
	}
}

func TestMultiTierDispatchServesKeysThatReachedL1WhileCollecting(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"c": "C"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, BatchTimeout: 60 * time.Millisecond})
	defer l.Close()

	results := make(map[string]string)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, k := range []string{"a", "b", "c"} {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			v, err := l.Load(context.Background(), k)
			if err != nil {
				t.Errorf("Load(%s): %v", k, err)
			}
			mu.Lock()
			results[k] = "<" + v + ">"
			mu.Unlock()
		}(k)
	}
	mtCovWaitActiveBatch(t, l, 3)
	// While the window is still open, a lands in L1 as a value and b as a known-missing key.
	l.Prime("a", "primed")
	l.l1.Set("b", multiTierHolder[string]{isMissing: true}, time.Minute)
	wg.Wait()

	if results["a"] != "<primed>" || results["b"] != "<>" || results["c"] != "<C>" {
		t.Fatalf("results = %v, want a from L1, b as missing, c from the DB", results)
	}
	if len(db.batches) != 1 || len(db.batches[0]) != 1 || db.batches[0][0] != "c" {
		t.Fatalf("batches = %v, want only the true L1 miss queried", db.batches)
	}
}

func TestMultiTierDispatchSkipsDBWhenAllKeysReachedL1(t *testing.T) {
	db := &mtCovDB{}
	l2 := newMtCovL2()
	l := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchFn: db.batch, BatchTimeout: 60 * time.Millisecond, L2Cache: l2, Deserialize: mtCovDeser,
	})
	defer l.Close()

	done := make(chan string, 1)
	go func() {
		v, _ := l.Load(context.Background(), "a")
		done <- v
	}()
	mtCovWaitActiveBatch(t, l, 1)
	l.l1.Set("a", multiTierHolder[string]{value: "late"}, time.Minute)

	if v := <-done; v != "late" {
		t.Fatalf("Load = %q, want the value that reached L1 during the window", v)
	}
	if db.calls() != 0 || l2.mgetCount() != 0 {
		t.Fatalf("lower tiers were queried (db=%d, mget=%d) although L1 satisfied the batch", db.calls(), l2.mgetCount())
	}
}

func TestMultiTierL2HitSkipsDBAndWarmsL1(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"b": "B"}}
	l2 := newMtCovL2()
	l2.data["a"] = []byte("s:fromL2")
	l := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchFn: db.batch, BatchTimeout: 20 * time.Millisecond, L2Cache: l2, L2TTL: 7 * time.Minute,
		Serialize: mtCovSer, Deserialize: mtCovDeser,
	})
	defer l.Close()

	got, err := l.LoadMany(context.Background(), []string{"a", "b"})
	if err != nil || got["a"] != "fromL2" || got["b"] != "B" {
		t.Fatalf("LoadMany = (%v, %v), want a from L2 and b from the DB", got, err)
	}
	if len(db.batches) != 1 || len(db.batches[0]) != 1 || db.batches[0][0] != "b" {
		t.Fatalf("batches = %v, want only the L2 miss queried", db.batches)
	}

	// The DB result is written back to L2 with the configured TTL; the L2 hit is not rewritten.
	l2.waitSet(t)
	l2.mu.Lock()
	if len(l2.sets) != 1 || string(l2.sets[0]["b"]) != "s:B" || len(l2.sets[0]) != 1 || l2.setTTLs[0] != 7*time.Minute {
		t.Fatalf("L2 writes = %v ttl %v, want exactly {b: s:B} with 7m", l2.sets, l2.setTTLs)
	}
	l2.mu.Unlock()

	// Both are now in L1: no further L2 or DB traffic.
	if v, err := l.Load(context.Background(), "a"); err != nil || v != "fromL2" {
		t.Fatalf("second Load(a) = (%q, %v)", v, err)
	}
	if l2.mgetCount() != 1 || db.calls() != 1 {
		t.Fatalf("L1 did not absorb the repeat load (mget=%d, db=%d)", l2.mgetCount(), db.calls())
	}
}

func TestMultiTierL2IgnoresKeysItWasNotAskedFor(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l2 := newMtCovL2()
	l2.extra = map[string][]byte{"intruder": []byte("s:evil")}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchFn: db.batch, L2Cache: l2, Deserialize: mtCovDeser,
	})
	defer l.Close()

	if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
		t.Fatalf("Load(a) = (%q, %v), want (A, nil) from the DB", v, err)
	}
	if _, ok := l.l1.Get("intruder"); ok {
		t.Fatal("an unrequested key returned by MGet was cached in L1")
	}
}

func TestMultiTierL2FailuresFallBackToDB(t *testing.T) {
	t.Run("MGet error", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "A"}}
		l2 := newMtCovL2()
		l2.mgetErr = errors.New("redis down")
		l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, L2Cache: l2, Deserialize: mtCovDeser})
		defer l.Close()

		if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
			t.Fatalf("Load = (%q, %v), want the DB value despite the L2 outage", v, err)
		}
	})

	t.Run("corrupt L2 payload", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "A"}}
		l2 := newMtCovL2()
		l2.data["a"] = []byte("garbage")
		l := NewMultiTierLoader(MultiTierConfig[string, string]{
			BatchFn: db.batch, L2Cache: l2,
			Deserialize: func([]byte) (string, error) { return "", errors.New("bad payload") },
		})
		defer l.Close()

		if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
			t.Fatalf("Load = (%q, %v), want the DB value when L2 bytes do not decode", v, err)
		}
		if db.calls() != 1 {
			t.Fatalf("BatchFn ran %d times, want 1", db.calls())
		}
	})

	t.Run("no Deserialize means L2 is not read", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "A"}}
		l2 := newMtCovL2()
		l2.data["a"] = []byte("s:stale")
		l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, L2Cache: l2})
		defer l.Close()

		if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
			t.Fatalf("Load = (%q, %v), want (A, nil)", v, err)
		}
		if l2.mgetCount() != 0 || l2.setCount() != 0 {
			t.Fatalf("L2 was used without codecs (mget=%d, set=%d)", l2.mgetCount(), l2.setCount())
		}
	})

	t.Run("Serialize error skips the L2 write-back", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "A"}}
		l2 := newMtCovL2()
		l := NewMultiTierLoader(MultiTierConfig[string, string]{
			BatchFn: db.batch, L2Cache: l2, Deserialize: mtCovDeser,
			Serialize: func(string) ([]byte, error) { return nil, errors.New("cannot encode") },
		})
		defer l.Close()

		if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
			t.Fatalf("Load = (%q, %v), want (A, nil)", v, err)
		}
		if l2.setCount() != 0 {
			t.Fatalf("L2 received %d writes although serialization failed", l2.setCount())
		}
	})

	t.Run("SetMany error does not fail the load", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "A"}}
		l2 := newMtCovL2()
		l2.setErr = errors.New("redis read-only")
		l := NewMultiTierLoader(MultiTierConfig[string, string]{
			BatchFn: db.batch, L2Cache: l2, Serialize: mtCovSer, Deserialize: mtCovDeser,
		})
		defer l.Close()

		if v, err := l.Load(context.Background(), "a"); err != nil || v != "A" {
			t.Fatalf("Load = (%q, %v), want (A, nil)", v, err)
		}
		l2.waitSet(t)
		if l2.setCount() != 1 {
			t.Fatalf("SetMany attempts = %d, want 1", l2.setCount())
		}
	})
}

func TestMultiTierPrimeWritesL1AndL2(t *testing.T) {
	db := &mtCovDB{}
	l2 := newMtCovL2()
	l := NewMultiTierLoader(MultiTierConfig[int, string]{
		BatchFn: func(ctx context.Context, _ []int) (map[int]string, error) {
			_, _ = db.batch(ctx, nil)
			return nil, nil
		},
		L2Cache:   l2,
		L2TTL:     3 * time.Minute,
		Serialize: mtCovSer,
		KeyToString: func(k int) string {
			if k == 7 {
				return "user:7"
			}
			return "other"
		},
	})
	defer l.Close()

	l.Prime(7, "seven")
	l2.waitSet(t)

	l2.mu.Lock()
	if len(l2.sets) != 1 || string(l2.sets[0]["user:7"]) != "s:seven" || l2.setTTLs[0] != 3*time.Minute {
		t.Fatalf("L2 writes = %v ttl %v, want {user:7: s:seven} with 3m", l2.sets, l2.setTTLs)
	}
	l2.mu.Unlock()

	if v, err := l.Load(context.Background(), 7); err != nil || v != "seven" {
		t.Fatalf("Load(7) = (%q, %v), want the primed value", v, err)
	}
	if db.calls() != 0 {
		t.Fatal("a primed key reached the DB")
	}
}

func TestMultiTierPrimeSkipsL2WhenSerializeFails(t *testing.T) {
	l2 := newMtCovL2()
	l := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchFn:   (&mtCovDB{}).batch,
		L2Cache:   l2,
		Serialize: func(string) ([]byte, error) { return nil, errors.New("cannot encode") },
	})
	defer l.Close()

	l.Prime("a", "A")
	time.Sleep(30 * time.Millisecond)
	if n := l2.setCount(); n != 0 {
		t.Fatalf("L2 received %d writes although serialization failed", n)
	}
	if h, ok := l.l1.Get("a"); !ok || h.value != "A" || h.isMissing {
		t.Fatalf("L1 entry = (%+v, %v), want the primed value regardless of L2", h, ok)
	}
}

func TestMultiTierPrefetchWarmsL1InBackground(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A", "b": "B"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
	defer l.Close()

	l.Prefetch(context.Background(), nil)
	l.Prefetch(context.Background(), []string{})
	time.Sleep(20 * time.Millisecond)
	if db.calls() != 0 {
		t.Fatalf("empty Prefetch triggered %d DB batches", db.calls())
	}

	// A caller context that is already cancelled must not abort the detached prefetch.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	l.Prefetch(ctx, []string{"a", "b"})

	deadline := time.Now().Add(2 * time.Second)
	for l.l1.Len() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("Prefetch did not warm L1 (len = %d)", l.l1.Len())
		}
		time.Sleep(time.Millisecond)
	}
	before := db.calls()
	if v, err := l.Load(context.Background(), "b"); err != nil || v != "B" {
		t.Fatalf("Load(b) = (%q, %v)", v, err)
	}
	if db.calls() != before {
		t.Fatal("a prefetched key was queried again")
	}
}

func TestMultiTierPrefetchHooksReceiveResolvedItemsOnly(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	got := make(chan []string, 2)
	var hookCalls int32
	l := NewMultiTierLoader(MultiTierConfig[string, string]{
		BatchFn:      db.batch,
		BatchTimeout: 20 * time.Millisecond,
		PrefetchHooks: []PrefetchHook[string]{func(ctx context.Context, items []string) {
			atomic.AddInt32(&hookCalls, 1)
			if ctx.Err() != nil {
				t.Errorf("hook context already done: %v", ctx.Err())
			}
			got <- items
		}},
	})
	defer l.Close()

	if _, err := l.LoadMany(context.Background(), []string{"a", "ghost"}); err != nil {
		t.Fatal(err)
	}
	select {
	case items := <-got:
		if len(items) != 1 || items[0] != "A" {
			t.Fatalf("hook items = %v, want only the row that exists", items)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prefetch hook never ran")
	}

	// A batch that resolves nothing does not invoke hooks.
	if _, err := l.Load(context.Background(), "ghost2"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if n := atomic.LoadInt32(&hookCalls); n != 1 {
		t.Fatalf("hook ran %d times, want 1", n)
	}
}

func TestMultiTierClear(t *testing.T) {
	t.Run("without L2 drops L1 and returns nil", func(t *testing.T) {
		db := &mtCovDB{rows: map[string]string{"a": "v1"}}
		l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch})
		defer l.Close()

		if v, _ := l.Load(context.Background(), "a"); v != "v1" {
			t.Fatalf("first Load = %q", v)
		}
		db.mu.Lock()
		db.rows["a"] = "v2"
		db.mu.Unlock()

		if err := l.Clear(context.Background(), "a"); err != nil {
			t.Fatalf("Clear = %v, want nil", err)
		}
		if v, err := l.Load(context.Background(), "a"); err != nil || v != "v2" {
			t.Fatalf("Load after Clear = (%q, %v), want the fresh v2", v, err)
		}
	})

	t.Run("deletes the stringified key from L2", func(t *testing.T) {
		l2 := newMtCovL2()
		l2.data["k:5"] = []byte("s:x")
		l := NewMultiTierLoader(MultiTierConfig[int, string]{
			BatchFn:     func(context.Context, []int) (map[int]string, error) { return nil, nil },
			L2Cache:     l2,
			KeyToString: func(k int) string { return "k:" + string(rune('0'+k)) },
		})
		defer l.Close()

		if err := l.Clear(context.Background(), 5); err != nil {
			t.Fatalf("Clear = %v", err)
		}
		if len(l2.deletes) != 1 || len(l2.deletes[0]) != 1 || l2.deletes[0][0] != "k:5" {
			t.Fatalf("L2 deletes = %v, want [[k:5]]", l2.deletes)
		}
		if _, still := l2.data["k:5"]; still {
			t.Fatal("key still present in L2")
		}
	})

	t.Run("returns the L2 delete error but still drops L1", func(t *testing.T) {
		boom := errors.New("redis down")
		l2 := newMtCovL2()
		l2.delErr = boom
		l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: (&mtCovDB{}).batch, L2Cache: l2})
		defer l.Close()
		l.l1.Set("a", multiTierHolder[string]{value: "A"}, time.Minute)

		if err := l.Clear(context.Background(), "a"); !errors.Is(err, boom) {
			t.Fatalf("Clear = %v, want redis down", err)
		}
		if _, ok := l.l1.Get("a"); ok {
			t.Fatal("L1 entry survived Clear")
		}
	})
}

func TestMultiTierCancelledSoleCallerDiscardsCollectingBatch(t *testing.T) {
	db := &mtCovDB{rows: map[string]string{"a": "A"}}
	l := NewMultiTierLoader(MultiTierConfig[string, string]{BatchFn: db.batch, BatchTimeout: time.Hour})
	defer l.Close()

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := l.Load(ctx, "a")
		errc <- err
	}()
	mtCovWaitActiveBatch(t, l, 1)
	cancel()

	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("Load = %v, want context.Canceled", err)
	}
	l.mu.Lock()
	active := l.activeBatch
	l.mu.Unlock()
	if active != nil {
		t.Fatal("abandoned batch is still the active batch; a later caller would join a cancelled one")
	}
	if db.calls() != 0 {
		t.Fatalf("BatchFn ran %d times for a batch nobody waits on", db.calls())
	}
}

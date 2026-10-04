package coalesce_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

// covRecorder is a BatchFn fake that records every invocation.
type covRecorder struct {
	mu    sync.Mutex
	calls [][]string
}

func (r *covRecorder) record(keys []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, append([]string(nil), keys...))
}

func (r *covRecorder) snapshot() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]string(nil), r.calls...)
}

type covLoadResult struct {
	val int
	err error
}

func covLoadAsync(l *coalesce.Loader[string, int], ctx context.Context, key string) <-chan covLoadResult {
	out := make(chan covLoadResult, 1)
	go func() {
		v, err := l.Load(ctx, key)
		out <- covLoadResult{v, err}
	}()
	return out
}

func covAwait(t *testing.T, ch <-chan covLoadResult) covLoadResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("Load did not return within 5s")
		return covLoadResult{}
	}
}

func TestLoaderCoverage_DefaultsApplyWhenConfigIsZero(t *testing.T) {
	rec := &covRecorder{}
	// Window 0 and MaxBatchSize 0 must fall back to 1ms / 100 rather than never dispatching.
	l := coalesce.New(coalesce.Config[string, int]{
		BatchFn: func(_ context.Context, keys []string) (map[string]int, error) {
			rec.record(keys)
			return map[string]int{"a": 1}, nil
		},
	})
	r := covAwait(t, covLoadAsync(l, context.Background(), "a"))
	if r.err != nil || r.val != 1 {
		t.Fatalf("got (%d, %v), want (1, nil)", r.val, r.err)
	}
	if calls := rec.snapshot(); len(calls) != 1 || len(calls[0]) != 1 || calls[0][0] != "a" {
		t.Fatalf("batch calls = %v, want one call with [a]", calls)
	}
}

func TestLoaderCoverage_FullBatchDispatchesWithoutWaitingForWindow(t *testing.T) {
	rec := &covRecorder{}
	l := coalesce.New(coalesce.Config[string, int]{
		Window:       time.Hour, // only the size trigger can dispatch
		MaxBatchSize: 2,
		BatchFn: func(_ context.Context, keys []string) (map[string]int, error) {
			rec.record(keys)
			return map[string]int{"a": 1, "b": 2}, nil
		},
	})
	ca := covLoadAsync(l, context.Background(), "a")
	cb := covLoadAsync(l, context.Background(), "b")
	ra, rb := covAwait(t, ca), covAwait(t, cb)
	if ra.err != nil || rb.err != nil || ra.val != 1 || rb.val != 2 {
		t.Fatalf("got a=%+v b=%+v, want 1 and 2", ra, rb)
	}
	calls := rec.snapshot()
	if len(calls) != 1 {
		t.Fatalf("batch ran %d times, want 1", len(calls))
	}
	got := append([]string(nil), calls[0]...)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("batch keys = %v, want [a b]", got)
	}
}

func TestLoaderCoverage_DuplicateKeysAreSentOnceAndFannedOut(t *testing.T) {
	rec := &covRecorder{}
	l := coalesce.New(coalesce.Config[string, int]{
		Window: 100 * time.Millisecond,
		BatchFn: func(_ context.Context, keys []string) (map[string]int, error) {
			rec.record(keys)
			return map[string]int{"dup": 7}, nil
		},
	})
	chans := []<-chan covLoadResult{
		covLoadAsync(l, context.Background(), "dup"),
		covLoadAsync(l, context.Background(), "dup"),
		covLoadAsync(l, context.Background(), "dup"),
	}
	for i, ch := range chans {
		if r := covAwait(t, ch); r.err != nil || r.val != 7 {
			t.Fatalf("caller %d got %+v, want 7", i, r)
		}
	}
	calls := rec.snapshot()
	if len(calls) != 1 || len(calls[0]) != 1 {
		t.Fatalf("batch calls = %v, want a single call with the key once", calls)
	}
}

func TestLoaderCoverage_BatchErrorReachesEveryCallerWithZeroValue(t *testing.T) {
	boom := errors.New("db down")
	l := coalesce.New(coalesce.Config[string, int]{
		Window: 50 * time.Millisecond,
		BatchFn: func(context.Context, []string) (map[string]int, error) {
			return map[string]int{"a": 1, "b": 2}, boom // partial data must be ignored on error
		},
	})
	ca := covLoadAsync(l, context.Background(), "a")
	cb := covLoadAsync(l, context.Background(), "b")
	for name, ch := range map[string]<-chan covLoadResult{"a": ca, "b": cb} {
		r := covAwait(t, ch)
		if !errors.Is(r.err, boom) {
			t.Fatalf("caller %s err = %v, want the batch error", name, r.err)
		}
		if r.val != 0 {
			t.Fatalf("caller %s got value %d alongside an error, want zero", name, r.val)
		}
	}
}

func TestLoaderCoverage_KeyMissingFromResultYieldsZeroValue(t *testing.T) {
	l := coalesce.New(coalesce.Config[string, int]{
		BatchFn: func(context.Context, []string) (map[string]int, error) { return nil, nil },
	})
	r := covAwait(t, covLoadAsync(l, context.Background(), "ghost"))
	if r.err != nil || r.val != 0 {
		t.Fatalf("got (%d, %v), want (0, nil) for a key the batch did not return", r.val, r.err)
	}
}

func TestLoaderCoverage_CancelledContextIsRejectedBeforeBatching(t *testing.T) {
	rec := &covRecorder{}
	l := coalesce.New(coalesce.Config[string, int]{
		BatchFn: func(_ context.Context, keys []string) (map[string]int, error) {
			rec.record(keys)
			return map[string]int{}, nil
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	v, err := l.Load(ctx, "a")
	if !errors.Is(err, context.Canceled) || v != 0 {
		t.Fatalf("got (%d, %v), want (0, context.Canceled)", v, err)
	}
	time.Sleep(30 * time.Millisecond) // well past the default 1ms window
	if calls := rec.snapshot(); len(calls) != 0 {
		t.Fatalf("a cancelled caller opened a batch: %v", calls)
	}

	// A primed value is served even on a cancelled context: no I/O is needed.
	l.Prime("warm", 5)
	if v, err := l.Load(ctx, "warm"); err != nil || v != 5 {
		t.Fatalf("primed key on cancelled ctx = (%d, %v), want (5, nil)", v, err)
	}
}

func TestLoaderCoverage_AbandonedBatchIsDiscardedAndNextCallerStartsFresh(t *testing.T) {
	rec := &covRecorder{}
	l := coalesce.New(coalesce.Config[string, int]{
		Window: 60 * time.Millisecond,
		BatchFn: func(_ context.Context, keys []string) (map[string]int, error) {
			rec.record(keys)
			return map[string]int{"second": 2}, nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := l.Load(ctx, "first"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
	time.Sleep(150 * time.Millisecond) // past the window the abandoned batch would have fired on
	if calls := rec.snapshot(); len(calls) != 0 {
		t.Fatalf("batch ran for a caller that had already given up: %v", calls)
	}

	r := covAwait(t, covLoadAsync(l, context.Background(), "second"))
	if r.err != nil || r.val != 2 {
		t.Fatalf("later caller got %+v, want 2", r)
	}
	calls := rec.snapshot()
	if len(calls) != 1 || len(calls[0]) != 1 || calls[0][0] != "second" {
		t.Fatalf("batch calls = %v, want exactly one call with [second]", calls)
	}
}

func TestLoaderCoverage_LastCallerCancellingAfterDispatchCancelsBatch(t *testing.T) {
	started := make(chan struct{})
	sawCancel := make(chan bool, 1)
	l := coalesce.New(coalesce.Config[string, int]{
		BatchFn: func(ctx context.Context, _ []string) (map[string]int, error) {
			close(started)
			select {
			case <-ctx.Done():
				sawCancel <- true
				return nil, ctx.Err()
			case <-time.After(3 * time.Second):
				sawCancel <- false
				return map[string]int{}, nil
			}
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	res := covLoadAsync(l, ctx, "a")
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("batch never started")
	}
	cancel()

	if r := covAwait(t, res); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("caller err = %v, want context.Canceled", r.err)
	}
	select {
	case cancelled := <-sawCancel:
		if !cancelled {
			t.Fatal("batch context was not cancelled after its only caller gave up")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("batch function never observed cancellation")
	}
}

type covCtxKey struct{}

func TestLoaderCoverage_BatchContextKeepsValuesAndLatestDeadline(t *testing.T) {
	type seen struct {
		deadline time.Time
		has      bool
		tenant   any
	}
	got := make(chan seen, 1)
	l := coalesce.New(coalesce.Config[string, int]{
		Window: 150 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]int, error) {
			d, ok := ctx.Deadline()
			got <- seen{d, ok, ctx.Value(covCtxKey{})}
			out := map[string]int{}
			for _, k := range keys {
				out[k] = len(k)
			}
			return out, nil
		},
	})

	base := context.WithValue(context.Background(), covCtxKey{}, "tenant-1")
	early := time.Now().Add(10 * time.Second)
	late := time.Now().Add(20 * time.Second)
	ctxEarly, cancelEarly := context.WithDeadline(base, early)
	defer cancelEarly()
	ctxLate, cancelLate := context.WithDeadline(context.Background(), late)
	defer cancelLate()

	c1 := covLoadAsync(l, ctxEarly, "a")
	time.Sleep(10 * time.Millisecond) // make ctxEarly the caller that opens the batch
	c2 := covLoadAsync(l, ctxLate, "bb")
	if r1, r2 := covAwait(t, c1), covAwait(t, c2); r1.err != nil || r2.err != nil || r1.val != 1 || r2.val != 2 {
		t.Fatalf("got %+v and %+v, want 1 and 2", r1, r2)
	}

	s := <-got
	if !s.has {
		t.Fatal("batch context lost its deadline although every caller had one")
	}
	if !s.deadline.Equal(late) {
		t.Fatalf("batch deadline = %v, want the latest caller deadline %v", s.deadline, late)
	}
	if s.tenant != "tenant-1" {
		t.Fatalf("batch context value = %v, want the opening caller's tenant-1", s.tenant)
	}
}

func TestLoaderCoverage_UnboundedCallerRemovesBatchDeadline(t *testing.T) {
	hasDeadline := make(chan bool, 1)
	l := coalesce.New(coalesce.Config[string, int]{
		Window: 150 * time.Millisecond,
		BatchFn: func(ctx context.Context, _ []string) (map[string]int, error) {
			_, ok := ctx.Deadline()
			hasDeadline <- ok
			return map[string]int{"a": 1, "b": 2}, nil
		},
	})
	bounded, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c1 := covLoadAsync(l, bounded, "a")
	c2 := covLoadAsync(l, context.Background(), "b")
	if r1, r2 := covAwait(t, c1), covAwait(t, c2); r1.err != nil || r2.err != nil {
		t.Fatalf("unexpected errors: %v / %v", r1.err, r2.err)
	}
	if <-hasDeadline {
		t.Fatal("batch must not carry a deadline when one caller has none")
	}
}

func TestLoaderCoverage_SingleFlightCallerHonoursItsOwnContext(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	l := coalesce.New(coalesce.Config[string, int]{
		SingleFlight: true,
		BatchFn: func(context.Context, []string) (map[string]int, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			<-release
			return map[string]int{"a": 11}, nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	impatient := covLoadAsync(l, ctx, "a")
	patient := covLoadAsync(l, context.Background(), "a")

	if r := covAwait(t, impatient); !errors.Is(r.err, context.DeadlineExceeded) || r.val != 0 {
		t.Fatalf("impatient caller got %+v, want (0, DeadlineExceeded)", r)
	}
	close(release)
	if r := covAwait(t, patient); r.err != nil || r.val != 11 {
		t.Fatalf("patient caller got %+v, want 11 (shared call must survive the other caller)", r)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("batch ran %d times, want 1", calls)
	}
}

func TestLoaderCoverage_SingleFlightPropagatesBatchError(t *testing.T) {
	boom := errors.New("upstream 503")
	l := coalesce.New(coalesce.Config[string, int]{
		SingleFlight: true,
		BatchFn:      func(context.Context, []string) (map[string]int, error) { return nil, boom },
	})
	r := covAwait(t, covLoadAsync(l, context.Background(), "a"))
	if !errors.Is(r.err, boom) || r.val != 0 {
		t.Fatalf("got %+v, want (0, upstream 503)", r)
	}
}

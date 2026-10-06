package coalesce

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func awaitResult[V any](t *testing.T, ch <-chan result[V]) result[V] {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("DoChan result did not arrive within 5s")
		return result[V]{}
	}
}

// fn runs on a goroutine no caller owns: a panic there must reach every waiter as an error
// instead of killing the process, and must not leave the key stuck in flight.
func TestGroup_DoChanTurnsPanicIntoSharedError(t *testing.T) {
	g := NewGroup[string, int]()
	started := make(chan struct{})
	release := make(chan struct{})

	first := g.DoChan("k", func() (int, error) {
		close(started)
		<-release
		panic("boom")
	})
	<-started
	joined := g.DoChan("k", func() (int, error) {
		t.Error("joined caller must share the in-flight call, not start its own")
		return 0, nil
	})
	close(release)

	for name, ch := range map[string]<-chan result[int]{"first": first, "joined": joined} {
		r := awaitResult(t, ch)
		if r.err == nil || !strings.Contains(r.err.Error(), "coalesce: panic: boom") || r.val != 0 {
			t.Fatalf("%s caller got %+v, want (0, coalesce: panic: boom)", name, r)
		}
	}

	// The key was released: a later call runs fn again.
	if r := awaitResult(t, g.DoChan("k", func() (int, error) { return 7, nil })); r.err != nil || r.val != 7 {
		t.Fatalf("call after a panic got %+v, want 7", r)
	}
}

// Pins the documented SingleFlight limit: the shared call is detached from its callers, so a
// batch whose callers have all timed out still runs, uncancelled and with no deadline.
func TestLoader_SingleFlightBatchOutlivesItsCallersWithoutDeadline(t *testing.T) {
	type seen struct {
		hasDeadline bool
		err         error
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	observed := make(chan seen, 1)
	loader := New(Config[string, string]{
		Window:       time.Millisecond,
		SingleFlight: true,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			_, has := ctx.Deadline()
			close(entered)
			<-release
			observed <- seen{hasDeadline: has, err: ctx.Err()}
			return map[string]string{"a": "A"}, nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := loader.Load(ctx, "a"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the only caller: expected DeadlineExceeded, got %v", err)
	}

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("BatchFn never ran")
	}
	close(release)
	select {
	case s := <-observed:
		if s.hasDeadline {
			t.Fatal("BatchFn context must carry no deadline under SingleFlight")
		}
		if s.err != nil {
			t.Fatalf("batch must not be cancelled when its callers give up under SingleFlight, got %v", s.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("BatchFn did not finish")
	}
}

// awaitDups blocks until n callers have joined the in-flight call for key.
func awaitDups[K comparable, V any](t *testing.T, g *Group[K, V], key K, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		g.mu.Lock()
		c, ok := g.m[key]
		joined := ok && c.dups >= n
		g.mu.Unlock()
		if joined {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d callers to join the flight for %v", n, key)
		}
		time.Sleep(time.Millisecond)
	}
}

// A waiter that calls Do again the moment it is woken must get a fresh call, never the
// finished one it was just handed: Do has to drop the key before it releases its waiters.
func TestGroup_DoDropsTheKeyBeforeWakingWaiters(t *testing.T) {
	const waiters = 8
	errLeader := errors.New("leader failed")

	for i := 0; i < 500; i++ {
		g := NewGroup[string, int]()
		release := make(chan struct{})
		leaderIn := make(chan struct{})
		go func() {
			_, _ = g.Do("k", func() (int, error) {
				close(leaderIn)
				<-release
				return 0, errLeader
			})
		}()
		<-leaderIn

		var stale int32
		var wg sync.WaitGroup
		for w := 0; w < waiters; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _ = g.Do("k", func() (int, error) { return 0, nil })
				if _, err := g.Do("k", func() (int, error) { return 1, nil }); errors.Is(err, errLeader) {
					atomic.AddInt32(&stale, 1)
				}
			}()
		}
		awaitDups(t, g, "k", waiters)
		close(release)
		wg.Wait()

		if n := atomic.LoadInt32(&stale); n != 0 {
			t.Fatalf("iteration %d: %d retrying waiter(s) were handed the finished call again", i, n)
		}
	}
}

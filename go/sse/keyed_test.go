package sse

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"
)

// keyedData drains the buffered events of ch without blocking.
func keyedData(ch <-chan Event[int]) []int {
	var got []int
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, e.Data)
		default:
			return got
		}
	}
}

func keyedEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// keyedWaitClosed fails unless ch reports closed (after any buffered events).
func keyedWaitClosed(t *testing.T, ch <-chan Event[int], what string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatalf("%s: channel was not closed", what)
		}
	}
}

func TestBroadcastTo_ReachesOnlyItsKey(t *testing.T) {
	b := NewBroadcaster[int](WithBufferSize(4), WithHistoryLimit(0))
	defer b.Close()
	a, aDropped, aCancel := b.SubscribeKey(context.Background(), "a")
	defer aCancel()
	a2, _, a2Cancel := b.SubscribeKey(context.Background(), "a")
	defer a2Cancel()
	other, _, oCancel := b.SubscribeKey(context.Background(), "b")
	defer oCancel()
	plain, pCancel := b.Subscribe(context.Background())
	defer pCancel()

	for i := 0; i < 10; i++ {
		b.BroadcastTo("b", Event[int]{Data: i}) // overflows b's buffer only
	}
	b.BroadcastTo("a", Event[int]{Data: 1})
	if len(a) != 1 || len(a2) != 1 {
		t.Fatalf("key a: buffered %d and %d, want 1 for every subscriber of the key", len(a), len(a2))
	}
	if aDropped() {
		t.Fatal("another key's overflow must not flag key a")
	}
	if len(other) != 4 || len(plain) != 0 {
		t.Fatalf("key b buffered %d (want 4), unkeyed buffered %d (want 0)", len(other), len(plain))
	}

	// Broadcast and Publish reach the unkeyed subscriber only.
	b.Broadcast(Event[int]{Data: 7})
	b.Publish(Event[int]{Data: 8})
	if len(plain) != 2 || len(a) != 1 {
		t.Fatalf("after Broadcast+Publish: unkeyed buffered %d (want 2), key a buffered %d (want 1)", len(plain), len(a))
	}

	// One sender, one key: send order is arrival order.
	b.BroadcastTo("a", Event[int]{Data: 2})
	b.BroadcastTo("a", Event[int]{Data: 3})
	if got := keyedData(a); !keyedEqual(got, []int{1, 2, 3}) {
		t.Fatalf("key a received %v, want [1 2 3]", got)
	}

	// A key nobody subscribed to: no-op, and no map entry is created.
	b.BroadcastTo("nobody", Event[int]{Data: 9})
	if _, ok := b.byKey["nobody"]; ok || len(b.byKey) != 2 {
		t.Fatalf("byKey = %d entries (nobody present: %v), want 2 and absent", len(b.byKey), ok)
	}
}

func TestBroadcastTo_NoHistory(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	_, _, cancel := b.SubscribeKey(context.Background(), "k")
	defer cancel()

	b.BroadcastTo("k", Event[int]{ID: "keyed-1", Data: 1})
	if h := b.History(); len(h) != 0 {
		t.Fatalf("history = %v, want empty after BroadcastTo", h)
	}

	b.Broadcast(Event[int]{ID: "plain-1", Data: 2})
	b.BroadcastTo("k", Event[int]{ID: "keyed-2", Data: 3})
	if h := b.History(); len(h) != 1 || h[0].ID != "plain-1" {
		t.Fatalf("history = %v, want only plain-1", h)
	}

	// The Last-Event-ID replay ServeHTTP performs never contains a keyed event.
	_, unsub, replayed := b.subscribe(context.Background(), "unknown-id")
	defer unsub()
	if len(replayed) != 1 || replayed[0].ID != "plain-1" {
		t.Fatalf("replayed = %v, want only plain-1", replayed)
	}
}

func TestBroadcastTo_EmptyKeyIsOrdinary(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	empty, _, eCancel := b.SubscribeKey(context.Background(), "")
	defer eCancel()
	named, _, nCancel := b.SubscribeKey(context.Background(), "k")
	defer nCancel()
	plain, pCancel := b.Subscribe(context.Background())
	defer pCancel()

	b.BroadcastTo("", Event[int]{Data: 1})
	if len(empty) != 1 || len(named) != 0 || len(plain) != 0 {
		t.Fatalf("BroadcastTo(\"\"): empty-key %d (want 1), named %d (want 0), unkeyed %d (want 0)", len(empty), len(named), len(plain))
	}
	b.Broadcast(Event[int]{Data: 2})
	if len(empty) != 1 || len(plain) != 1 {
		t.Fatalf("Broadcast: empty-key %d (want 1), unkeyed %d (want 1)", len(empty), len(plain))
	}
}

func TestBroadcastTo_Timestamp(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	ch, _, cancel := b.SubscribeKey(context.Background(), "k")
	defer cancel()

	before := time.Now().UnixMilli()
	b.BroadcastTo("k", Event[int]{Data: 1})
	b.BroadcastTo("k", Event[int]{Data: 2, Timestamp: 42})
	after := time.Now().UnixMilli()

	if e := <-ch; e.Timestamp < before || e.Timestamp > after {
		t.Fatalf("zero timestamp became %d, want within [%d, %d]", e.Timestamp, before, after)
	}
	if e := <-ch; e.Timestamp != 42 {
		t.Fatalf("explicit timestamp = %d, want 42 untouched", e.Timestamp)
	}
}

func TestSubscribeKey_FlagsAnOverflowOnce(t *testing.T) {
	b := NewBroadcaster[int](WithBufferSize(4), WithHistoryLimit(0))
	defer b.Close()
	ch, dropped, cancel := b.SubscribeKey(context.Background(), "k1")
	defer cancel()
	if cap(ch) != 4 {
		t.Fatalf("cap = %d, want the configured buffer size 4", cap(ch))
	}

	// A second subscriber of the same key keeps reading, so it never overflows.
	roomy, roomyDropped, roomyCancel := b.SubscribeKey(context.Background(), "k1")
	defer roomyCancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 10; i++ {
			b.BroadcastTo("k1", Event[int]{Data: i})
			<-roomy
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("BroadcastTo blocked on a full subscriber buffer")
	}

	if got := len(ch); got != 4 {
		t.Fatalf("buffered = %d, want 4", got)
	}
	if got := keyedData(ch); !keyedEqual(got, []int{0, 1, 2, 3}) {
		t.Fatalf("kept events = %v, want [0 1 2 3] (the new event is discarded, not the backlog)", got)
	}
	// Sticky: draining the channel above did not clear the flag.
	if !dropped() {
		t.Fatal("overflow not flagged")
	}
	if dropped() {
		t.Fatal("dropped() must reset after reporting")
	}
	if roomyDropped() {
		t.Fatal("a same-key subscriber with room in its buffer must not be flagged")
	}

	// A new drop raises the flag again.
	for i := 0; i < 5; i++ {
		b.BroadcastTo("k1", Event[int]{Data: i})
	}
	if !dropped() {
		t.Fatal("a new overflow was not flagged")
	}
}

func TestSubscribeKey_DefaultBufferSize(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	ch, _, cancel := b.SubscribeKey(context.Background(), "k")
	defer cancel()
	if cap(ch) != 64 {
		t.Fatalf("cap = %d, want the default 64", cap(ch))
	}
}

func TestMarkAllDropped(t *testing.T) {
	b := NewBroadcaster[int]()
	a, aDropped, aCancel := b.SubscribeKey(context.Background(), "a")
	a2, a2Dropped, a2Cancel := b.SubscribeKey(context.Background(), "a")
	defer a2Cancel()
	c, cDropped, cCancel := b.SubscribeKey(context.Background(), "c")
	defer cCancel()
	plain, pCancel := b.Subscribe(context.Background())
	defer pCancel()

	if aDropped() || a2Dropped() || cDropped() {
		t.Fatal("a fresh subscriber must not be flagged")
	}

	// A quiet key: the flag is raised although no event arrives.
	b.MarkAllDropped()
	if len(a) != 0 || len(a2) != 0 || len(c) != 0 || len(plain) != 0 {
		t.Fatal("MarkAllDropped must send nothing")
	}
	if b.SubscriberCount() != 4 {
		t.Fatalf("SubscriberCount = %d, want 4 (MarkAllDropped closes nothing)", b.SubscriberCount())
	}
	if !aDropped() || !a2Dropped() || !cDropped() {
		t.Fatal("MarkAllDropped must flag every keyed subscriber of every key")
	}
	if aDropped() || a2Dropped() || cDropped() {
		t.Fatal("dropped() must reset after reporting")
	}

	// dropped() stays callable after cancel and after Close.
	b.MarkAllDropped()
	aCancel()
	if !aDropped() || aDropped() {
		t.Fatal("after cancel, dropped() must still report the flag once, then false")
	}
	b.Close()
	if !cDropped() || cDropped() {
		t.Fatal("after Close, dropped() must still report the flag once, then false")
	}
}

func TestSubscribeKey_Cancel(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	ch1, _, cancel1 := b.SubscribeKey(context.Background(), "k")
	ch2, _, cancel2 := b.SubscribeKey(context.Background(), "k")
	_, _, cancelOther := b.SubscribeKey(context.Background(), "other")

	b.BroadcastTo("k", Event[int]{Data: 1})
	b.BroadcastTo("k", Event[int]{Data: 2})
	cancel1()

	// Buffered events are still readable, then the channel reports closed.
	if a, c := <-ch1, <-ch1; a.Data != 1 || c.Data != 2 {
		t.Fatalf("buffered after cancel = %d, %d; want 1, 2", a.Data, c.Data)
	}
	if _, ok := <-ch1; ok {
		t.Fatal("channel still open after cancel")
	}
	if len(b.byKey["k"]) != 1 || len(b.byKey) != 2 {
		t.Fatalf("after first cancel: key k has %d subscribers (want 1), byKey has %d keys (want 2)", len(b.byKey["k"]), len(b.byKey))
	}

	cancel1() // idempotent
	b.BroadcastTo("k", Event[int]{Data: 3})
	if got := keyedData(ch2); !keyedEqual(got, []int{1, 2, 3}) {
		t.Fatalf("remaining subscriber received %v, want [1 2 3]", got)
	}

	cancel2()
	if _, ok := b.byKey["k"]; ok {
		t.Fatal("key entry not deleted when its last subscriber cancelled")
	}
	cancelOther()
	if len(b.byKey) != 0 {
		t.Fatalf("len(byKey) = %d after all subscribers cancelled, want 0", len(b.byKey))
	}
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d, want 0", b.SubscriberCount())
	}
}

func TestSubscribeKey_ContextCancel(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	ctx, stop := context.WithCancel(context.Background())
	ch, _, cancel := b.SubscribeKey(ctx, "k")
	defer cancel()

	stop()
	keyedWaitClosed(t, ch, "context cancelled")
	waitForSubscribers(t, b, 0)
	b.mu.RLock()
	n := len(b.byKey)
	b.mu.RUnlock()
	if n != 0 {
		t.Fatalf("len(byKey) = %d after context cancel, want 0", n)
	}
}

func TestSubscribeKey_NilContext(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()

	// Twenty subscribers and a margin of ten, so that an unrelated goroutine
	// starting or exiting meanwhile cannot decide the result.
	const n = 20
	before := runtime.NumGoroutine()
	for i := 0; i < n; i++ {
		//nolint:staticcheck // a nil context is part of the documented contract
		_, _, c := b.SubscribeKey(nil, "quiet")
		defer c()
	}
	if after := runtime.NumGoroutine(); after >= before+n/2 {
		t.Fatalf("goroutines %d -> %d for %d subscribers: a nil context must not start a watcher", before, after, n)
	}

	//nolint:staticcheck // as above
	ch, _, cancel := b.SubscribeKey(nil, "k")

	b.BroadcastTo("k", Event[int]{Data: 1})
	if e := <-ch; e.Data != 1 {
		t.Fatalf("received %d, want 1", e.Data)
	}
	cancel()
	if _, ok := <-ch; ok {
		t.Fatal("channel still open after cancel")
	}

	//nolint:staticcheck // as above
	ch2, _, cancel2 := b.SubscribeKey(nil, "k")
	defer cancel2()
	b.Close()
	if _, ok := <-ch2; ok {
		t.Fatal("channel still open after Close")
	}
}

func TestSubscribeKey_WatcherGoroutineExits(t *testing.T) {
	const n = 20
	waitBackTo := func(t *testing.T, baseline int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for runtime.NumGoroutine() > baseline {
			if time.Now().After(deadline) {
				t.Fatalf("goroutines = %d, want back to the baseline %d: watchers leaked", runtime.NumGoroutine(), baseline)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	subscribeAll := func(t *testing.T, b *Broadcaster[int], ctx context.Context, baseline int) []func() {
		t.Helper()
		cancels := make([]func(), 0, n)
		for i := 0; i < n; i++ {
			_, _, cancel := b.SubscribeKey(ctx, "k")
			cancels = append(cancels, cancel)
		}
		// Half of n, not n: goroutines left over from earlier tests may exit meanwhile.
		if got := runtime.NumGoroutine(); got < baseline+n/2 {
			t.Fatalf("goroutines = %d, want about %d: one watcher per subscriber", got, baseline+n)
		}
		return cancels
	}

	t.Run("context done", func(t *testing.T) {
		b := NewBroadcaster[int]()
		defer b.Close()
		baseline := runtime.NumGoroutine()
		ctx, stop := context.WithCancel(context.Background())
		subscribeAll(t, b, ctx, baseline)
		stop()
		waitBackTo(t, baseline)
	})

	t.Run("cancel called", func(t *testing.T) {
		b := NewBroadcaster[int]()
		defer b.Close()
		baseline := runtime.NumGoroutine()
		for _, cancel := range subscribeAll(t, b, context.Background(), baseline) {
			cancel()
		}
		waitBackTo(t, baseline)
	})

	t.Run("broadcaster closed", func(t *testing.T) {
		b := NewBroadcaster[int]()
		baseline := runtime.NumGoroutine()
		subscribeAll(t, b, context.Background(), baseline)
		b.Close()
		waitBackTo(t, baseline)
	})
}

func TestSubscriberCount_IncludesKeyed(t *testing.T) {
	b := NewBroadcaster[int]()
	defer b.Close()
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d, want 0", b.SubscriberCount())
	}
	_, _, cancelA := b.SubscribeKey(context.Background(), "a")
	_, _, cancelB := b.SubscribeKey(context.Background(), "b")
	_, cancelPlain := b.Subscribe(context.Background())
	if b.SubscriberCount() != 3 {
		t.Fatalf("SubscriberCount = %d, want 3 (two keyed plus one unkeyed)", b.SubscriberCount())
	}
	cancelA()
	if b.SubscriberCount() != 2 {
		t.Fatalf("SubscriberCount = %d, want 2 after a keyed cancel", b.SubscriberCount())
	}
	cancelPlain()
	cancelB()
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d, want 0", b.SubscriberCount())
	}
}

func TestClose_WithLiveKeyedAndUnkeyedSubscribers(t *testing.T) {
	b := NewBroadcaster[int]()
	ctx := context.Background()
	plain, unsub1 := b.Subscribe(ctx)
	defer unsub1()
	keyed, _, unsub2 := b.SubscribeKey(ctx, "k1")
	defer unsub2()
	keyed2, _, unsub3 := b.SubscribeKey(ctx, "k2")
	defer unsub3()

	closed := make(chan struct{})
	go func() {
		b.Close()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(1 * time.Second):
		t.Fatal("Broadcaster.Close did not return within 1s: deadlocked with live subscribers")
	}

	keyedWaitClosed(t, plain, "unkeyed subscriber")
	keyedWaitClosed(t, keyed, "keyed subscriber k1")
	keyedWaitClosed(t, keyed2, "keyed subscriber k2")
	if len(b.subscribers) != 0 || len(b.byKey) != 0 {
		t.Fatalf("after Close: %d unkeyed and %d keys left, want both maps empty", len(b.subscribers), len(b.byKey))
	}
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d after Close, want 0", b.SubscriberCount())
	}
}

func TestKeyed_AfterClose(t *testing.T) {
	b := NewBroadcaster[int]()
	_, oldDropped, oldCancel := b.SubscribeKey(context.Background(), "k")
	b.Close()

	oldCancel() // a cancel after Close does nothing and does not panic
	oldCancel()
	if oldDropped() {
		t.Fatal("dropped() after Close reported a drop that never happened")
	}

	ch, dropped, cancel := b.SubscribeKey(context.Background(), "k")
	if _, ok := <-ch; ok {
		t.Fatal("SubscribeKey after Close must return an already closed channel")
	}

	b.BroadcastTo("k", Event[int]{Data: 1})
	b.MarkAllDropped()
	if dropped() || oldDropped() {
		t.Fatal("after Close, MarkAllDropped and BroadcastTo must do nothing and dropped() must stay false")
	}
	cancel()
	cancel()
	if b.SubscriberCount() != 0 || len(b.byKey) != 0 {
		t.Fatalf("after Close: SubscriberCount %d, %d keys; want 0 and 0", b.SubscriberCount(), len(b.byKey))
	}
}

// Every keyed and unkeyed operation at once. A send on a closed channel would
// panic, and the race detector checks the rest.
func TestKeyed_ConcurrentAccess(t *testing.T) {
	b := NewBroadcaster[int](WithBufferSize(2))
	keys := []string{"a", "b", ""}

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				key := keys[(g+i)%len(keys)]
				ctx, stop := context.WithCancel(context.Background())
				ch, dropped, cancel := b.SubscribeKey(ctx, key)
				plain, cancelPlain := b.Subscribe(ctx)

				b.BroadcastTo(key, Event[int]{Data: i})
				b.Broadcast(Event[int]{Data: i})
				b.MarkAllDropped()
				_ = b.SubscriberCount()
				_ = dropped()
				select {
				case <-ch:
				default:
				}
				select {
				case <-plain:
				default:
				}

				if i%2 == 0 {
					stop()
				}
				cancel()
				cancelPlain()
				stop()
			}
		}(g)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(2 * time.Millisecond)
		b.Close()
	}()

	finished := make(chan struct{})
	go func() {
		wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent keyed access deadlocked")
	}
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d after Close and every cancel, want 0", b.SubscriberCount())
	}
}

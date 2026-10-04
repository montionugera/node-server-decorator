package sse

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// sseCovWriter is a goroutine-safe ResponseWriter + Flusher that can start failing writes.
type sseCovWriter struct {
	mu        sync.Mutex
	header    http.Header
	status    int
	body      strings.Builder
	writes    int
	flushes   int
	failAfter int // writes allowed before every further Write fails; <0 = never fail
	attempted []string
}

func newSSECovWriter(failAfter int) *sseCovWriter {
	return &sseCovWriter{header: http.Header{}, failAfter: failAfter}
}

func (w *sseCovWriter) Header() http.Header { return w.header }

func (w *sseCovWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.status = status
}

func (w *sseCovWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.attempted = append(w.attempted, string(p))
	if w.failAfter >= 0 && w.writes >= w.failAfter {
		return 0, errors.New("client gone")
	}
	w.writes++
	return w.body.Write(p)
}

func (w *sseCovWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.flushes++
}

func (w *sseCovWriter) snapshot() (body string, attempted []string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.String(), append([]string(nil), w.attempted...)
}

// sseCovServe runs ServeHTTP in a goroutine and returns a channel closed when it returns.
func sseCovServe[T any](b *Broadcaster[T], w http.ResponseWriter, r *http.Request) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.ServeHTTP(w, r)
	}()
	return done
}

func sseCovWaitDone(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("handler did not return: %s", what)
	}
}

func sseCovWaitSubs[T any](t *testing.T, b *Broadcaster[T], n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for b.SubscriberCount() != n {
		if time.Now().After(deadline) {
			t.Fatalf("SubscriberCount = %d, want %d", b.SubscriberCount(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

func sseCovWaitBody(t *testing.T, w *sseCovWriter, want string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		body, _ := w.snapshot()
		if strings.Contains(body, want) {
			return body
		}
		if time.Now().After(deadline) {
			t.Fatalf("body never contained %q; got %q", want, body)
		}
		time.Sleep(time.Millisecond)
	}
}

func sseCovRequest(ctx context.Context, lastID string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/events", nil).WithContext(ctx)
	if lastID != "" {
		r.Header.Set("Last-Event-ID", lastID)
	}
	return r
}

func TestNewBroadcasterOptionHandling(t *testing.T) {
	def := NewBroadcaster[string]()
	if def.bufferSize != 64 || def.historyLimit != 100 || def.heartbeat != 15*time.Second {
		t.Fatalf("defaults = buffer %d, history %d, heartbeat %v", def.bufferSize, def.historyLimit, def.heartbeat)
	}

	for _, n := range []int{0, -3} {
		b := NewBroadcaster[string](WithBufferSize(n))
		ch, cancel := b.Subscribe(context.Background())
		if cap(ch) != 64 {
			t.Fatalf("WithBufferSize(%d): channel capacity = %d, want the default 64", n, cap(ch))
		}
		cancel()
	}

	custom := NewBroadcaster[string](nil, WithBufferSize(3), WithHistoryLimit(5), WithHeartbeat(0), nil)
	ch, cancel := custom.Subscribe(context.Background())
	defer cancel()
	if cap(ch) != 3 || custom.historyLimit != 5 || custom.heartbeat != 0 {
		t.Fatalf("custom = cap %d, history %d, heartbeat %v", cap(ch), custom.historyLimit, custom.heartbeat)
	}
}

func TestBroadcastFillsMissingTimestampOnly(t *testing.T) {
	b := NewBroadcaster[string]()
	before := time.Now().UnixMilli()
	b.Broadcast(Event[string]{ID: "auto", Data: "x"})
	b.Publish(Event[string]{ID: "preset", Data: "y", Timestamp: 12345})
	after := time.Now().UnixMilli()

	h := b.History()
	if len(h) != 2 {
		t.Fatalf("history has %d events, want 2 (Publish must behave like Broadcast)", len(h))
	}
	if h[0].Timestamp < before || h[0].Timestamp > after {
		t.Fatalf("auto timestamp %d outside [%d, %d]", h[0].Timestamp, before, after)
	}
	if h[1].Timestamp != 12345 {
		t.Fatalf("preset timestamp = %d, want it preserved", h[1].Timestamp)
	}
}

func TestHistoryIsBoundedRingAndCopied(t *testing.T) {
	b := NewBroadcaster[int](WithHistoryLimit(2))
	for i := 1; i <= 4; i++ {
		b.Broadcast(Event[int]{ID: string(rune('0' + i)), Data: i})
	}
	h := b.History()
	if len(h) != 2 || h[0].Data != 3 || h[1].Data != 4 {
		t.Fatalf("history = %+v, want only the two newest events in order", h)
	}

	h[0].Data = 999
	if again := b.History(); again[0].Data != 3 {
		t.Fatalf("mutating a History() snapshot changed the broadcaster: %+v", again)
	}
}

func TestHistoryDisabledWhenLimitNotPositive(t *testing.T) {
	for _, limit := range []int{0, -1} {
		b := NewBroadcaster[int](WithHistoryLimit(limit))
		ch, cancel := b.Subscribe(context.Background())
		b.Broadcast(Event[int]{ID: "1", Data: 1})

		if h := b.History(); len(h) != 0 {
			t.Fatalf("limit %d: history = %+v, want none kept", limit, h)
		}
		if e := <-ch; e.Data != 1 {
			t.Fatalf("limit %d: live delivery broken, got %+v", limit, e)
		}
		cancel()
	}
}

func TestBroadcastAfterCloseIsDropped(t *testing.T) {
	b := NewBroadcaster[string]()
	b.Broadcast(Event[string]{ID: "1", Data: "kept"})
	b.Close()
	b.Broadcast(Event[string]{ID: "2", Data: "dropped"})
	b.Close() // idempotent

	h := b.History()
	if len(h) != 1 || h[0].ID != "1" {
		t.Fatalf("history = %+v, want the post-Close event ignored", h)
	}
}

func TestSubscribeAfterCloseReturnsClosedChannel(t *testing.T) {
	b := NewBroadcaster[string]()
	b.Close()

	ch, cancel := b.Subscribe(context.Background())
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("received an event from a closed broadcaster")
		}
	case <-time.After(time.Second):
		t.Fatal("channel from a closed broadcaster is not closed")
	}
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount = %d, want 0", b.SubscriberCount())
	}
	cancel()
	cancel() // must be a harmless no-op
}

func TestCloseClosesEverySubscriberChannel(t *testing.T) {
	b := NewBroadcaster[string]()
	ch1, cancel1 := b.Subscribe(context.Background())
	ch2, _ := b.Subscribe(nil) //nolint:staticcheck // nil ctx is an accepted input
	if b.SubscriberCount() != 2 {
		t.Fatalf("SubscriberCount = %d, want 2", b.SubscriberCount())
	}

	b.Close()
	for i, ch := range []<-chan Event[string]{ch1, ch2} {
		if _, ok := <-ch; ok {
			t.Fatalf("subscriber %d channel still open after Close", i)
		}
	}
	if b.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount after Close = %d", b.SubscriberCount())
	}
	cancel1() // cancel after Close must not double-close
}

func TestUnsubscribeIsIdempotentAndStopsDelivery(t *testing.T) {
	b := NewBroadcaster[string]()
	ch, cancel := b.Subscribe(nil) //nolint:staticcheck // nil ctx is an accepted input
	other, cancelOther := b.Subscribe(context.Background())
	defer cancelOther()

	cancel()
	cancel()
	if b.SubscriberCount() != 1 {
		t.Fatalf("SubscriberCount = %d, want 1 after unsubscribing one of two", b.SubscriberCount())
	}
	if _, ok := <-ch; ok {
		t.Fatal("unsubscribed channel is not closed")
	}

	b.Broadcast(Event[string]{ID: "1", Data: "x"})
	if e := <-other; e.ID != "1" {
		t.Fatalf("remaining subscriber got %+v", e)
	}
}

func TestContextCancelUnsubscribes(t *testing.T) {
	b := NewBroadcaster[string]()
	ctx, cancelCtx := context.WithCancel(context.Background())
	ch, _ := b.Subscribe(ctx)
	sseCovWaitSubs(t, b, 1)

	cancelCtx()
	sseCovWaitSubs(t, b, 0)
	if _, ok := <-ch; ok {
		t.Fatal("channel still open after its context was cancelled")
	}
}

func TestSlowSubscriberDropsOverflowWithoutBlocking(t *testing.T) {
	b := NewBroadcaster[int](WithBufferSize(2))
	slow, cancelSlow := b.Subscribe(context.Background())
	defer cancelSlow()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 1; i <= 5; i++ {
			b.Broadcast(Event[int]{Data: i})
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Broadcast blocked on a full subscriber buffer")
	}

	if len(slow) != 2 {
		t.Fatalf("buffered events = %d, want exactly the buffer size 2", len(slow))
	}
	if a, c := <-slow, <-slow; a.Data != 1 || c.Data != 2 {
		t.Fatalf("kept events = %d, %d; want the first two (overflow is dropped, not the backlog)", a.Data, c.Data)
	}
	if len(b.History()) != 5 {
		t.Fatalf("history has %d events, want all 5 even though the subscriber dropped some", len(b.History()))
	}
}

func TestSubscribeReplaySelection(t *testing.T) {
	b := NewBroadcaster[int]()
	for i := 1; i <= 3; i++ {
		b.Broadcast(Event[int]{ID: string(rune('a' + i - 1)), Data: i})
	}

	ids := func(lastID string) string {
		_, cancel, replayed := b.subscribe(context.Background(), lastID)
		defer cancel()
		var out []string
		for _, e := range replayed {
			out = append(out, e.ID)
		}
		return strings.Join(out, ",")
	}

	cases := map[string]string{
		"":        "",      // no Last-Event-ID: nothing replayed
		"a":       "b,c",   // after the first
		"b":       "c",     // after the middle
		"c":       "",      // already up to date
		"unknown": "a,b,c", // id fell out of (or never was in) history: replay everything
	}
	for lastID, want := range cases {
		if got := ids(lastID); got != want {
			t.Errorf("replay after %q = %q, want %q", lastID, got, want)
		}
	}

	empty := NewBroadcaster[int]()
	_, cancel, replayed := empty.subscribe(context.Background(), "anything")
	defer cancel()
	if replayed != nil {
		t.Fatalf("replay from empty history = %+v, want nil", replayed)
	}
}

func TestServeHTTPRejectsNonFlusher(t *testing.T) {
	b := NewBroadcaster[string]()
	rec := httptest.NewRecorder()
	// Hide the recorder's Flush method.
	w := struct{ http.ResponseWriter }{rec}

	b.ServeHTTP(w, sseCovRequest(context.Background(), ""))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var problem map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if problem["status"] != float64(500) || problem["title"] != "Internal Server Error" || problem["type"] != "about:blank" {
		t.Fatalf("problem = %v", problem)
	}
	if b.SubscriberCount() != 0 {
		t.Fatal("a rejected request left a subscriber behind")
	}
}

func TestServeHTTPSetsHeadersAndStreamsLiveEvents(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	w := newSSECovWriter(-1)
	ctx, cancel := context.WithCancel(context.Background())
	done := sseCovServe(b, w, sseCovRequest(ctx, ""))
	sseCovWaitSubs(t, b, 1)

	b.Broadcast(Event[string]{ID: "1", Event: "greet", Data: "hi", Timestamp: 1})
	body := sseCovWaitBody(t, w, "\n\n")
	if body != "id: 1\nevent: greet\ndata: \"hi\"\n\n" {
		t.Fatalf("frame = %q", body)
	}

	cancel()
	sseCovWaitDone(t, done, "request context cancelled")
	sseCovWaitSubs(t, b, 0)

	if w.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.status)
	}
	want := map[string]string{
		"Content-Type":      "text/event-stream; charset=utf-8",
		"Cache-Control":     "no-cache, no-transform",
		"Connection":        "keep-alive",
		"X-Accel-Buffering": "no",
	}
	for k, v := range want {
		if got := w.header.Get(k); got != v {
			t.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	if w.flushes < 2 {
		t.Fatalf("flushes = %d, want headers and the event each flushed", w.flushes)
	}
}

func TestServeHTTPReplaysFromQueryParamAndSkipsUnencodableEvents(t *testing.T) {
	b := NewBroadcaster[any](WithHeartbeat(0))
	b.Broadcast(Event[any]{ID: "1", Data: "one"})
	b.Broadcast(Event[any]{ID: "2", Data: make(chan int)}) // json.Marshal fails
	b.Broadcast(Event[any]{ID: "3", Data: "three"})

	w := newSSECovWriter(-1)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodGet, "/events?lastEventId=1", nil).WithContext(ctx)
	done := sseCovServe(b, w, r)
	sseCovWaitBody(t, w, "id: 3")

	// Live: an unencodable event is skipped and the stream keeps going.
	b.Broadcast(Event[any]{ID: "4", Data: func() {}})
	b.Broadcast(Event[any]{ID: "5", Data: "five"})
	body := sseCovWaitBody(t, w, "id: 5")

	cancel()
	sseCovWaitDone(t, done, "request context cancelled")

	if want := "id: 3\ndata: \"three\"\n\nid: 5\ndata: \"five\"\n\n"; body != want {
		t.Fatalf("stream = %q, want %q (event 1 already seen, 2 and 4 unencodable)", body, want)
	}
}

func TestServeHTTPHeaderLastEventIDWinsOverQuery(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	for _, id := range []string{"1", "2", "3"} {
		b.Broadcast(Event[string]{ID: id, Data: id})
	}

	w := newSSECovWriter(-1)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodGet, "/events?lastEventId=1", nil).WithContext(ctx)
	r.Header.Set("Last-Event-ID", "2")
	done := sseCovServe(b, w, r)
	sseCovWaitBody(t, w, "id: 3")
	cancel()
	sseCovWaitDone(t, done, "request context cancelled")

	if body, _ := w.snapshot(); body != "id: 3\ndata: \"3\"\n\n" {
		t.Fatalf("stream = %q, want only the event after header id 2", body)
	}
}

func TestServeHTTPStopsWhenReplayWriteFails(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	b.Broadcast(Event[string]{ID: "1", Data: "a"})
	b.Broadcast(Event[string]{ID: "2", Data: "b"})

	w := newSSECovWriter(0)
	done := sseCovServe(b, w, sseCovRequest(context.Background(), "unknown"))
	sseCovWaitDone(t, done, "replay write failed")

	if _, attempted := w.snapshot(); len(attempted) != 1 || !strings.HasPrefix(attempted[0], "id: 1\n") {
		t.Fatalf("write attempts = %q, want to stop after the first failed frame", attempted)
	}
	sseCovWaitSubs(t, b, 0)
}

func TestServeHTTPStopsWhenLiveWriteFails(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	w := newSSECovWriter(1)
	done := sseCovServe(b, w, sseCovRequest(context.Background(), ""))
	sseCovWaitSubs(t, b, 1)

	b.Broadcast(Event[string]{ID: "1", Data: "ok"})
	sseCovWaitBody(t, w, "id: 1")
	b.Broadcast(Event[string]{ID: "2", Data: "fails"})
	sseCovWaitDone(t, done, "live write failed")

	body, attempted := w.snapshot()
	if body != "id: 1\ndata: \"ok\"\n\n" || len(attempted) != 2 {
		t.Fatalf("body = %q, attempts = %d; want one delivered frame then a stop", body, len(attempted))
	}
	sseCovWaitSubs(t, b, 0)
}

func TestServeHTTPHeartbeat(t *testing.T) {
	t.Run("pings while idle", func(t *testing.T) {
		b := NewBroadcaster[string](WithHeartbeat(5 * time.Millisecond))
		w := newSSECovWriter(-1)
		ctx, cancel := context.WithCancel(context.Background())
		done := sseCovServe(b, w, sseCovRequest(ctx, ""))

		sseCovWaitBody(t, w, ": ping\n\n: ping\n\n")
		cancel()
		sseCovWaitDone(t, done, "request context cancelled")
	})

	t.Run("stops when the ping cannot be written", func(t *testing.T) {
		b := NewBroadcaster[string](WithHeartbeat(5 * time.Millisecond))
		w := newSSECovWriter(0)
		done := sseCovServe(b, w, sseCovRequest(context.Background(), ""))
		sseCovWaitDone(t, done, "heartbeat write failed")

		if _, attempted := w.snapshot(); len(attempted) != 1 || attempted[0] != ": ping\n\n" {
			t.Fatalf("write attempts = %q, want a single failed ping", attempted)
		}
		sseCovWaitSubs(t, b, 0)
	})

	t.Run("disabled heartbeat sends nothing", func(t *testing.T) {
		b := NewBroadcaster[string](WithHeartbeat(-time.Second))
		w := newSSECovWriter(-1)
		ctx, cancel := context.WithCancel(context.Background())
		done := sseCovServe(b, w, sseCovRequest(ctx, ""))
		sseCovWaitSubs(t, b, 1)
		time.Sleep(30 * time.Millisecond)
		cancel()
		sseCovWaitDone(t, done, "request context cancelled")

		if body, _ := w.snapshot(); body != "" {
			t.Fatalf("body = %q, want no output with the heartbeat disabled", body)
		}
	})
}

func TestServeHTTPReturnsWhenBroadcasterCloses(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	w := newSSECovWriter(-1)
	done := sseCovServe(b, w, sseCovRequest(context.Background(), ""))
	sseCovWaitSubs(t, b, 1)

	b.Close()
	sseCovWaitDone(t, done, "broadcaster closed")
}

func TestServeHTTPReturnsWhenItsSubscriptionIsClosed(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	w := newSSECovWriter(-1)
	done := sseCovServe(b, w, sseCovRequest(context.Background(), ""))
	sseCovWaitSubs(t, b, 1)

	// Drop the handler's subscription exactly as its cancel func would, while the request
	// context and the broadcaster both stay alive: only the closed channel can end the loop.
	b.mu.Lock()
	for id, sub := range b.subscribers {
		delete(b.subscribers, id)
		close(sub.done)
		close(sub.ch)
	}
	b.mu.Unlock()

	sseCovWaitDone(t, done, "subscription channel closed")
	if body, _ := w.snapshot(); body != "" {
		t.Fatalf("body = %q, want nothing written for a closed subscription", body)
	}
}

func TestServeHTTPOnClosedBroadcasterReturnsImmediately(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	b.Broadcast(Event[string]{ID: "1", Data: "a"})
	b.Close()

	w := newSSECovWriter(-1)
	done := sseCovServe(b, w, sseCovRequest(context.Background(), "unknown"))
	sseCovWaitDone(t, done, "broadcaster already closed")

	if body, _ := w.snapshot(); body != "" {
		t.Fatalf("body = %q, want no replay from a closed broadcaster", body)
	}
	if w.status != http.StatusOK {
		t.Fatalf("status = %d, want the stream to open with 200 before ending", w.status)
	}
}

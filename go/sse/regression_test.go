package sse

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Close must not deadlock against subscriber cancel functions that fire at
// the same moment (graceful shutdown: request contexts cancelled while Close runs).
func TestBroadcaster_CloseDoesNotDeadlockAgainstCancel(t *testing.T) {
	for iter := 0; iter < 20; iter++ {
		b := NewBroadcaster[string](WithHeartbeat(0))
		ctx, cancelCtx := context.WithCancel(context.Background())
		for i := 0; i < 2000; i++ {
			b.Subscribe(ctx)
		}

		done := make(chan struct{})
		go func() {
			cancelCtx()
			b.Close()
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("iteration %d: Close deadlocked against subscriber cancel", iter)
		}

		// The broadcaster lock must be free afterwards.
		counted := make(chan int, 1)
		go func() { counted <- b.SubscriberCount() }()
		select {
		case n := <-counted:
			if n != 0 {
				t.Fatalf("iteration %d: expected 0 subscribers after Close, got %d", iter, n)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("iteration %d: SubscriberCount hung after Close", iter)
		}
	}
}

// cancel must stay idempotent and safe to call after Close.
func TestBroadcaster_CancelIdempotentAfterClose(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	ch, cancel := b.Subscribe(nil)
	cancel()
	cancel()
	if _, ok := <-ch; ok {
		t.Fatal("expected channel closed after cancel")
	}

	ch2, cancel2 := b.Subscribe(nil)
	b.Close()
	cancel2()
	if _, ok := <-ch2; ok {
		t.Fatal("expected channel closed after Close")
	}
}

// openStream connects to the SSE endpoint and returns a channel of "id: " values.
func openStream(t *testing.T, ctx context.Context, url, lastEventID string) <-chan string {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	ids := make(chan string, 64)
	go func() {
		defer resp.Body.Close()
		defer close(ids)
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			if id, ok := strings.CutPrefix(scanner.Text(), "id: "); ok {
				ids <- id
			}
		}
	}()
	return ids
}

func expectID(t *testing.T, ids <-chan string, want string) {
	t.Helper()
	select {
	case got, ok := <-ids:
		if !ok {
			t.Fatalf("stream closed before id %q", want)
		}
		if got != want {
			t.Fatalf("expected id %q, got %q", want, got)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for id %q", want)
	}
}

func waitForSubscribers[T any](t *testing.T, b *Broadcaster[T], n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for b.SubscriberCount() != n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d subscribers", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// After a replay, live events must be delivered even when their ID sorts at or
// below the last replayed ID (UUID-style, non-monotonic IDs).
func TestBroadcaster_LiveEventsAfterReplay_NonMonotonicIDs(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	defer b.Close()
	server := httptest.NewServer(b)
	defer server.Close()

	b.Broadcast(Event[string]{ID: "f3c1", Data: "one"})
	b.Broadcast(Event[string]{ID: "zz99", Data: "two"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ids := openStream(t, ctx, server.URL, "f3c1")
	expectID(t, ids, "zz99")

	waitForSubscribers(t, b, 1)
	b.Broadcast(Event[string]{ID: "0a11", Data: "three"})
	expectID(t, ids, "0a11")
	b.Broadcast(Event[string]{ID: "zz99", Data: "same id, new event"})
	expectID(t, ids, "zz99")
}

// A Last-Event-ID that is not in the history buffer replays the whole buffer,
// in order, regardless of how the IDs sort.
func TestBroadcaster_UnknownLastEventID_ReplaysWholeHistory(t *testing.T) {
	b := NewBroadcaster[string](WithHeartbeat(0))
	defer b.Close()
	server := httptest.NewServer(b)
	defer server.Close()

	b.Broadcast(Event[string]{ID: "bbb", Data: "one"})
	b.Broadcast(Event[string]{ID: "aaa", Data: "two"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ids := openStream(t, ctx, server.URL, "unknown-id")
	expectID(t, ids, "bbb")
	expectID(t, ids, "aaa")
}

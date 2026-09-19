package sse

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type nonFlusherResponseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *nonFlusherResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *nonFlusherResponseWriter) Write(b []byte) (int, error) {
	return w.body.Write(b)
}

func (w *nonFlusherResponseWriter) WriteHeader(status int) {
	w.status = status
}

func TestEvent_Format(t *testing.T) {
	t.Run("minimal event with data only", func(t *testing.T) {
		evt := Event[string]{
			Data: "hello",
		}
		raw, err := evt.Format()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expected := "data: \"hello\"\n\n"
		if string(raw) != expected {
			t.Fatalf("expected %q, got %q", expected, string(raw))
		}
	})

	t.Run("full event with ID, Event, and struct Data", func(t *testing.T) {
		type Payload struct {
			Message string `json:"message"`
			Count   int    `json:"count"`
		}
		evt := Event[Payload]{
			ID:        "evt-100",
			Event:     "user.created",
			Timestamp: 1600000000000,
			Data: Payload{
				Message: "Alice",
				Count:   42,
			},
		}
		raw, err := evt.Format()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expected := "id: evt-100\nevent: user.created\ndata: {\"message\":\"Alice\",\"count\":42}\n\n"
		if string(raw) != expected {
			t.Fatalf("expected %q, got %q", expected, string(raw))
		}
	})

	t.Run("event with ID and int data", func(t *testing.T) {
		evt := Event[int]{
			ID:   "123",
			Data: 42,
		}
		raw, err := evt.Format()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		expected := "id: 123\ndata: 42\n\n"
		if string(raw) != expected {
			t.Fatalf("expected %q, got %q", expected, string(raw))
		}
	})
}

func TestBroadcaster_ServeHTTP_Headers(t *testing.T) {
	broadcaster := NewBroadcaster[string](WithHeartbeat(0))
	defer broadcaster.Close()

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to perform request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 OK, got %d", resp.StatusCode)
	}

	expectedHeaders := map[string]string{
		"Content-Type":      "text/event-stream; charset=utf-8",
		"Cache-Control":     "no-cache, no-transform",
		"Connection":        "keep-alive",
		"X-Accel-Buffering": "no",
	}

	for k, v := range expectedHeaders {
		if got := resp.Header.Get(k); got != v {
			t.Errorf("expected header %q to be %q, got %q", k, v, got)
		}
	}
}

func TestBroadcaster_Publish_And_Receive(t *testing.T) {
	type ChatEvent struct {
		User string `json:"user"`
		Text string `json:"text"`
	}

	broadcaster := NewBroadcaster[ChatEvent](WithHeartbeat(0))
	defer broadcaster.Close()

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to perform request: %v", err)
	}
	defer resp.Body.Close()

	// Wait until client is subscribed
	for i := 0; i < 50; i++ {
		if broadcaster.SubscriberCount() > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	broadcaster.Publish(Event[ChatEvent]{
		ID:    "1",
		Event: "message",
		Data: ChatEvent{
			User: "Alice",
			Text: "Hello SSE!",
		},
	})

	reader := bufio.NewReader(resp.Body)
	lines := make([]string, 0, 4)
	for len(lines) < 4 {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("failed reading line: %v", err)
		}
		lines = append(lines, strings.TrimRight(line, "\r\n"))
	}

	if lines[0] != "id: 1" {
		t.Errorf("expected 'id: 1', got %q", lines[0])
	}
	if lines[1] != "event: message" {
		t.Errorf("expected 'event: message', got %q", lines[1])
	}
	if lines[2] != "data: {\"user\":\"Alice\",\"text\":\"Hello SSE!\"}" {
		t.Errorf("unexpected data line: %q", lines[2])
	}
	if lines[3] != "" {
		t.Errorf("expected empty line ending frame, got %q", lines[3])
	}
}

func TestBroadcaster_LastEventID_Replay(t *testing.T) {
	broadcaster := NewBroadcaster[string](
		WithHeartbeat(0),
		WithHistoryLimit(10),
	)
	defer broadcaster.Close()

	// Pre-publish 3 events
	broadcaster.Broadcast(Event[string]{ID: "1", Data: "first"})
	broadcaster.Broadcast(Event[string]{ID: "2", Data: "second"})
	broadcaster.Broadcast(Event[string]{ID: "3", Data: "third"})

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	t.Run("replay via Last-Event-ID header", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			t.Fatalf("failed to create request: %v", err)
		}
		req.Header.Set("Last-Event-ID", "1")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("failed to perform request: %v", err)
		}
		defer resp.Body.Close()

		reader := bufio.NewReader(resp.Body)
		// Should immediately receive event 2, then event 3
		frame1 := readSSEFrame(t, reader)
		if frame1["id"] != "2" || frame1["data"] != "\"second\"" {
			t.Fatalf("expected event 2, got %v", frame1)
		}

		frame2 := readSSEFrame(t, reader)
		if frame2["id"] != "3" || frame2["data"] != "\"third\"" {
			t.Fatalf("expected event 3, got %v", frame2)
		}
	})

	t.Run("replay via lastEventId query parameter", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"?lastEventId=2", nil)
		if err != nil {
			t.Fatalf("failed to create request: %v", err)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("failed to perform request: %v", err)
		}
		defer resp.Body.Close()

		reader := bufio.NewReader(resp.Body)
		// Should immediately receive event 3
		frame := readSSEFrame(t, reader)
		if frame["id"] != "3" || frame["data"] != "\"third\"" {
			t.Fatalf("expected event 3, got %v", frame)
		}
	})
}

func TestBroadcaster_Heartbeat(t *testing.T) {
	broadcaster := NewBroadcaster[string](
		WithHeartbeat(25 * time.Millisecond),
	)
	defer broadcaster.Close()

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to perform request: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	// Read until heartbeat line
	foundHeartbeat := false
	for i := 0; i < 5; i++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("error reading line: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == ": ping" {
			foundHeartbeat = true
			break
		}
	}

	if !foundHeartbeat {
		t.Fatalf("heartbeat ': ping' frame not received")
	}
}

func TestBroadcaster_ClientDisconnect(t *testing.T) {
	broadcaster := NewBroadcaster[string](WithHeartbeat(0))
	defer broadcaster.Close()

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to perform request: %v", err)
	}
	defer resp.Body.Close()

	// Verify subscriber registered
	for i := 0; i < 50; i++ {
		if broadcaster.SubscriberCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if broadcaster.SubscriberCount() != 1 {
		t.Fatalf("expected 1 subscriber, got %d", broadcaster.SubscriberCount())
	}

	// Cancel context to simulate client disconnect
	cancel()

	// Verify subscriber is cleaned up
	cleanedUp := false
	for i := 0; i < 50; i++ {
		if broadcaster.SubscriberCount() == 0 {
			cleanedUp = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !cleanedUp {
		t.Fatalf("subscriber was not cleaned up after disconnect, count: %d", broadcaster.SubscriberCount())
	}
}

func TestBroadcaster_NonBlocking(t *testing.T) {
	broadcaster := NewBroadcaster[int](
		WithBufferSize(2),
		WithHeartbeat(0),
	)
	defer broadcaster.Close()

	// Slow subscriber that does not read
	slowCh, slowCancel := broadcaster.Subscribe(context.Background())
	defer slowCancel()

	// Active subscriber that does read
	activeCh, activeCancel := broadcaster.Subscribe(context.Background())
	defer activeCancel()

	// Broadcast 20 events. The slow subscriber's buffer (2) will overflow,
	// but Broadcast must NOT block.
	doneBroadcast := make(chan struct{})
	go func() {
		for i := 1; i <= 20; i++ {
			broadcaster.Broadcast(Event[int]{ID: "id", Data: i})
		}
		close(doneBroadcast)
	}()

	select {
	case <-doneBroadcast:
		// Succeeded without blocking
	case <-time.After(1 * time.Second):
		t.Fatal("Broadcast blocked on slow subscriber")
	}

	// Active subscriber should be able to receive events up to its buffer
	receivedCount := 0
	for {
		select {
		case <-activeCh:
			receivedCount++
		default:
			goto doneReading
		}
	}
doneReading:
	if receivedCount == 0 {
		t.Fatal("active subscriber did not receive any events")
	}

	// Ensure slow subscriber channel still has at most its buffer capacity
	slowCount := 0
	for {
		select {
		case <-slowCh:
			slowCount++
		default:
			goto doneSlow
		}
	}
doneSlow:
	if slowCount > 2 {
		t.Fatalf("slow subscriber exceeded buffer size, got %d", slowCount)
	}
}

func TestBroadcaster_Close(t *testing.T) {
	broadcaster := NewBroadcaster[string](WithHeartbeat(0))

	server := httptest.NewServer(broadcaster)
	defer server.Close()

	resp, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer resp.Body.Close()

	for i := 0; i < 50; i++ {
		if broadcaster.SubscriberCount() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	broadcaster.Close()

	// Response body should reach EOF
	buf := make([]byte, 128)
	_, readErr := resp.Body.Read(buf)
	if readErr != io.EOF && readErr != nil && !strings.Contains(readErr.Error(), "closed") {
		t.Logf("connection closed with: %v", readErr)
	}

	if broadcaster.SubscriberCount() != 0 {
		t.Fatalf("expected 0 subscribers after close, got %d", broadcaster.SubscriberCount())
	}
}

func TestBroadcaster_UnsupportedFlusher(t *testing.T) {
	broadcaster := NewBroadcaster[string](WithHeartbeat(0))
	defer broadcaster.Close()

	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	w := &nonFlusherResponseWriter{}

	broadcaster.ServeHTTP(w, req)

	if w.status != http.StatusInternalServerError {
		t.Fatalf("expected status 500, got %d", w.status)
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("expected problem json content type, got %q", ct)
	}

	var prob map[string]any
	if err := json.Unmarshal(w.body.Bytes(), &prob); err != nil {
		t.Fatalf("failed to parse problem json: %v", err)
	}
	if prob["status"] != float64(500) {
		t.Fatalf("expected status 500 in problem, got %v", prob["status"])
	}
}

func TestBroadcaster_ConcurrentAccess(t *testing.T) {
	broadcaster := NewBroadcaster[int](
		WithBufferSize(16),
		WithHeartbeat(0),
		WithHistoryLimit(50),
	)
	defer broadcaster.Close()

	var wg sync.WaitGroup

	// Start 10 subscribers
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ch, cancel := broadcaster.Subscribe(context.Background())
			defer cancel()

			for j := 0; j < 5; j++ {
				select {
				case <-ch:
				case <-time.After(100 * time.Millisecond):
					return
				}
			}
		}()
	}

	// Publish concurrently
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(senderID int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				broadcaster.Publish(Event[int]{
					ID:   "evt",
					Data: senderID*100 + j,
				})
			}
		}(i)
	}

	wg.Wait()
}

func readSSEFrame(t *testing.T, r *bufio.Reader) map[string]string {
	t.Helper()
	result := make(map[string]string)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("failed to read SSE line: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// End of frame
			return result
		}
		if strings.HasPrefix(line, ":") {
			result["comment"] = strings.TrimSpace(line[1:])
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimPrefix(parts[1], " ")
			result[key] = val
		}
	}
}

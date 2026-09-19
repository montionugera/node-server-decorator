package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type options struct {
	heartbeat    time.Duration
	bufferSize   int
	historyLimit int
}

// Option configures Broadcaster settings.
type Option func(*options)

// WithHeartbeat configures the periodic heartbeat duration.
// A duration <= 0 disables the heartbeat.
func WithHeartbeat(d time.Duration) Option {
	return func(o *options) {
		o.heartbeat = d
	}
}

// WithBufferSize configures the subscriber channel buffer capacity.
func WithBufferSize(n int) Option {
	return func(o *options) {
		o.bufferSize = n
	}
}

// WithHistoryLimit configures the maximum number of recent events stored in the ring buffer for replay.
func WithHistoryLimit(n int) Option {
	return func(o *options) {
		o.historyLimit = n
	}
}

func defaultOptions() options {
	return options{
		heartbeat:    15 * time.Second,
		bufferSize:   64,
		historyLimit: 100,
	}
}

type subscriber[T any] struct {
	ch   chan Event[T]
	done chan struct{}
	once sync.Once
}

// Broadcaster coordinates SSE event fan-out, client subscriptions, and HTTP streaming.
type Broadcaster[T any] struct {
	mu           sync.RWMutex
	subscribers  map[uint64]*subscriber[T]
	nextSubID    uint64
	history      []Event[T]
	historyLimit int
	bufferSize   int
	heartbeat    time.Duration
	closed       bool
	closeOnce    sync.Once
	done         chan struct{}
}

// NewBroadcaster constructs a new Broadcaster instance for typed events.
func NewBroadcaster[T any](opts ...Option) *Broadcaster[T] {
	opt := defaultOptions()
	for _, o := range opts {
		if o != nil {
			o(&opt)
		}
	}
	if opt.bufferSize <= 0 {
		opt.bufferSize = 64
	}

	return &Broadcaster[T]{
		subscribers:  make(map[uint64]*subscriber[T]),
		historyLimit: opt.historyLimit,
		bufferSize:   opt.bufferSize,
		heartbeat:    opt.heartbeat,
		done:         make(chan struct{}),
	}
}

// Broadcast broadcasts an event to all active subscribers.
// Channel sends are non-blocking; slow subscribers whose buffer is full drop the event.
func (b *Broadcaster[T]) Broadcast(event Event[T]) {
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}

	if b.historyLimit > 0 {
		if len(b.history) >= b.historyLimit {
			b.history = append(b.history[1:], event)
		} else {
			b.history = append(b.history, event)
		}
	}

	for _, sub := range b.subscribers {
		select {
		case sub.ch <- event:
		default:
			// Non-blocking drop/skip for slow subscriber
		}
	}
	b.mu.Unlock()
}

// Publish is an alias for Broadcast.
func (b *Broadcaster[T]) Publish(event Event[T]) {
	b.Broadcast(event)
}

// Subscribe registers a new subscriber channel.
// Returns the event receive channel and an unsubscribe cancel function.
func (b *Broadcaster[T]) Subscribe(ctx context.Context) (<-chan Event[T], func()) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		ch := make(chan Event[T])
		close(ch)
		return ch, func() {}
	}

	id := b.nextSubID
	b.nextSubID++

	sub := &subscriber[T]{
		ch:   make(chan Event[T], b.bufferSize),
		done: make(chan struct{}),
	}
	b.subscribers[id] = sub
	b.mu.Unlock()

	cancel := func() {
		sub.once.Do(func() {
			close(sub.done)
			b.mu.Lock()
			delete(b.subscribers, id)
			close(sub.ch)
			b.mu.Unlock()
		})
	}

	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				cancel()
			case <-sub.done:
			case <-b.done:
				cancel()
			}
		}()
	}

	return sub.ch, cancel
}

// SubscriberCount returns the number of active subscribers.
func (b *Broadcaster[T]) SubscriberCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subscribers)
}

// History returns a snapshot of cached events.
func (b *Broadcaster[T]) History() []Event[T] {
	b.mu.RLock()
	defer b.mu.RUnlock()
	res := make([]Event[T], len(b.history))
	copy(res, b.history)
	return res
}

// Close shuts down the broadcaster and unsubscribes all active clients.
func (b *Broadcaster[T]) Close() {
	b.closeOnce.Do(func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.closed = true
		close(b.done)
		for id, sub := range b.subscribers {
			delete(b.subscribers, id)
			sub.once.Do(func() {
				close(sub.done)
				close(sub.ch)
			})
		}
	})
}

func isAfter(a, b string) bool {
	aNum, errA := strconv.ParseInt(a, 10, 64)
	bNum, errB := strconv.ParseInt(b, 10, 64)
	if errA == nil && errB == nil {
		return aNum > bNum
	}
	return a > b
}

func (b *Broadcaster[T]) getEventsAfter(lastID string) []Event[T] {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if len(b.history) == 0 {
		return nil
	}

	// If lastID exists in history, return all events occurring after it
	foundIdx := -1
	for i, e := range b.history {
		if e.ID == lastID {
			foundIdx = i
			break
		}
	}

	if foundIdx != -1 {
		if foundIdx+1 < len(b.history) {
			replayed := make([]Event[T], len(b.history)-(foundIdx+1))
			copy(replayed, b.history[foundIdx+1:])
			return replayed
		}
		return nil
	}

	// If lastID not directly in history, return events whose ID is after lastID
	var replayed []Event[T]
	for _, e := range b.history {
		if isAfter(e.ID, lastID) {
			replayed = append(replayed, e)
		}
	}
	return replayed
}

// ServeHTTP implements http.Handler for SSE streaming.
func (b *Broadcaster[T]) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":   "about:blank",
			"title":  "Internal Server Error",
			"status": http.StatusInternalServerError,
			"detail": "Streaming unsupported: client does not implement http.Flusher",
		})
		return
	}

	// Set required SSE headers
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")

	// Flush headers immediately
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Check Last-Event-ID header (or lastEventId query param)
	lastID := r.Header.Get("Last-Event-ID")
	if lastID == "" {
		lastID = r.URL.Query().Get("lastEventId")
	}

	ch, cancel := b.Subscribe(r.Context())
	defer cancel()

	var highestReplayedID string
	if lastID != "" {
		replayed := b.getEventsAfter(lastID)
		for _, e := range replayed {
			frame, err := e.Format()
			if err != nil {
				continue
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			highestReplayedID = e.ID
		}
		if len(replayed) > 0 {
			flusher.Flush()
		}
	}

	var tickerChan <-chan time.Time
	if b.heartbeat > 0 {
		ticker := time.NewTicker(b.heartbeat)
		defer ticker.Stop()
		tickerChan = ticker.C
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-b.done:
			return
		case <-tickerChan:
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-ch:
			if !ok {
				return
			}
			// Avoid duplicate replay if event was already sent during replay
			if highestReplayedID != "" && event.ID != "" && !isAfter(event.ID, highestReplayedID) {
				continue
			}
			frame, err := event.Format()
			if err != nil {
				continue
			}
			if _, err := w.Write(frame); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

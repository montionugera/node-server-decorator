package core_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

// mockCacheAdapter is an in-memory cache adapter for testing.
type mockCacheAdapter struct {
	mu          sync.Mutex
	store       map[string]any
	useSentinel bool
	getCalled   int
	setCalled   int
}

func newMockCacheAdapter(useSentinel bool) *mockCacheAdapter {
	return &mockCacheAdapter{
		store:       make(map[string]any),
		useSentinel: useSentinel,
	}
}

func (m *mockCacheAdapter) Get(ctx context.Context, key string) (any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.getCalled++

	val, found := m.store[key]
	if !found {
		if m.useSentinel {
			return core.CacheMiss, nil
		}
		return nil, core.ErrCacheMiss
	}
	return val, nil
}

func (m *mockCacheAdapter) Set(ctx context.Context, key string, val any, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.setCalled++
	m.store[key] = val
	return nil
}

// mockQueueAdapter records messages published through it.
type mockQueueAdapter struct {
	mu       sync.Mutex
	messages []core.QueueMessage
}

func (q *mockQueueAdapter) Publish(ctx context.Context, msg core.QueueMessage) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.messages = append(q.messages, msg)
	return nil
}

func (q *mockQueueAdapter) Messages() []core.QueueMessage {
	q.mu.Lock()
	defer q.mu.Unlock()
	copied := make([]core.QueueMessage, len(q.messages))
	copy(copied, q.messages)
	return copied
}

func TestCache_HitsMissesAndEvaluation(t *testing.T) {
	ctx := context.Background()

	t.Run("miss then hit with ErrCacheMiss", func(t *testing.T) {
		adapter := newMockCacheAdapter(false)
		evalCount := 0

		compute := func(ctx context.Context, id string) (int, error) {
			evalCount++
			return len(id) * 10, nil
		}

		cachedCompute := core.Cache[string, int](adapter, "Service.compute", 5*time.Minute, compute)

		// First call: cache miss, compute called
		res1, err := cachedCompute(ctx, "hello")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res1 != 50 {
			t.Fatalf("expected 50, got %d", res1)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount 1, got %d", evalCount)
		}

		// Second call: cache hit, compute NOT called
		res2, err := cachedCompute(ctx, "hello")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res2 != 50 {
			t.Fatalf("expected 50, got %d", res2)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount to stay 1, got %d", evalCount)
		}

		// Third call with different arg: cache miss
		res3, err := cachedCompute(ctx, "hi")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res3 != 20 {
			t.Fatalf("expected 20, got %d", res3)
		}
		if evalCount != 2 {
			t.Fatalf("expected evalCount 2, got %d", evalCount)
		}
	})

	t.Run("miss with CacheMiss sentinel", func(t *testing.T) {
		adapter := newMockCacheAdapter(true) // returns CacheMiss instead of ErrCacheMiss
		evalCount := 0

		greet := func(ctx context.Context, name string) (string, error) {
			evalCount++
			return "Hello, " + name, nil
		}

		cachedGreet := core.Cache[string, string](adapter, "Greeter.greet", time.Minute, greet)

		res1, err := cachedGreet(ctx, "Alice")
		if err != nil || res1 != "Hello, Alice" {
			t.Fatalf("unexpected result: %q, err: %v", res1, err)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount 1, got %d", evalCount)
		}

		// Second call should hit cache
		res2, err := cachedGreet(ctx, "Alice")
		if err != nil || res2 != "Hello, Alice" {
			t.Fatalf("unexpected result: %q, err: %v", res2, err)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount 1, got %d", evalCount)
		}
	})

	t.Run("caches nil/zero-value without re-evaluating", func(t *testing.T) {
		adapter := newMockCacheAdapter(false)
		evalCount := 0

		findUser := func(ctx context.Context, id string) (*string, error) {
			evalCount++
			return nil, nil // legitimate nil value
		}

		cachedFindUser := core.Cache[string, *string](adapter, "UserService.find", time.Minute, findUser)

		// First call: computes and returns nil
		res1, err := cachedFindUser(ctx, "missing-user")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res1 != nil {
			t.Fatalf("expected nil, got %v", res1)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount 1, got %d", evalCount)
		}

		// Second call: must hit cache and return nil WITHOUT re-evaluating findUser
		res2, err := cachedFindUser(ctx, "missing-user")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res2 != nil {
			t.Fatalf("expected nil, got %v", res2)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount to stay 1, got %d (nil was not cached!)", evalCount)
		}
	})

	t.Run("error from fn is propagated and not cached", func(t *testing.T) {
		adapter := newMockCacheAdapter(false)
		evalCount := 0
		boomErr := errors.New("boom")

		failFunc := func(ctx context.Context, x int) (int, error) {
			evalCount++
			return 0, boomErr
		}

		cachedFail := core.Cache[int, int](adapter, "Service.fail", time.Minute, failFunc)

		_, err := cachedFail(ctx, 1)
		if !errors.Is(err, boomErr) {
			t.Fatalf("expected boomErr, got %v", err)
		}
		if evalCount != 1 {
			t.Fatalf("expected evalCount 1, got %d", evalCount)
		}

		// Second call should re-evaluate because previous call errored
		_, err = cachedFail(ctx, 1)
		if !errors.Is(err, boomErr) {
			t.Fatalf("expected boomErr, got %v", err)
		}
		if evalCount != 2 {
			t.Fatalf("expected evalCount 2, got %d", evalCount)
		}
	})
}

func TestEmitOnSuccess(t *testing.T) {
	ctx := context.Background()

	t.Run("publishes QueueMessage on success", func(t *testing.T) {
		queue := &mockQueueAdapter{}

		createOrder := func(ctx context.Context, item string) (map[string]any, error) {
			return map[string]any{"orderId": "ord-123", "item": item}, nil
		}

		before := time.Now().UnixMilli()
		wrapped := core.EmitOnSuccess(queue, "OrderService.create", createOrder)

		res, err := wrapped(ctx, "book")
		after := time.Now().UnixMilli()

		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res["orderId"] != "ord-123" {
			t.Fatalf("expected ord-123, got %v", res["orderId"])
		}

		msgs := queue.Messages()
		if len(msgs) != 1 {
			t.Fatalf("expected 1 message, got %d", len(msgs))
		}

		msg := msgs[0]
		if msg.EventName != "OrderService.create" {
			t.Errorf("expected eventName 'OrderService.create', got %q", msg.EventName)
		}
		if msg.Timestamp < before || msg.Timestamp > after {
			t.Errorf("timestamp %d out of range [%d, %d]", msg.Timestamp, before, after)
		}

		payloadMap, ok := msg.Payload.(map[string]any)
		if !ok || payloadMap["orderId"] != "ord-123" {
			t.Errorf("payload mismatch: %#v", msg.Payload)
		}

		// Ensure QueueMessage serializes to valid JSON matching schema
		data, err := json.Marshal(msg)
		if err != nil {
			t.Fatalf("failed to marshal QueueMessage to JSON: %v", err)
		}
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("failed to unmarshal JSON: %v", err)
		}
		if parsed["eventName"] != "OrderService.create" || parsed["timestamp"] == nil {
			t.Errorf("JSON output missing required fields: %s", string(data))
		}
	})

	t.Run("does not publish on error", func(t *testing.T) {
		queue := &mockQueueAdapter{}
		expectedErr := errors.New("db error")

		failingOp := func(ctx context.Context, id string) (string, error) {
			return "", expectedErr
		}

		wrapped := core.EmitOnSuccess(queue, "Service.fail", failingOp)

		_, err := wrapped(ctx, "test")
		if !errors.Is(err, expectedErr) {
			t.Fatalf("expected expectedErr, got %v", err)
		}

		if len(queue.Messages()) != 0 {
			t.Fatalf("expected 0 published messages, got %d", len(queue.Messages()))
		}
	})

	t.Run("with metadata and transform options", func(t *testing.T) {
		queue := &mockQueueAdapter{}
		topic := "orders.created"

		meta := &core.QueueMessageMetadata{
			ClassName:  "OrderService",
			MethodName: "create",
			Topic:      &topic,
			Service:    "order-service",
		}

		op := func(ctx context.Context, in int) (int, error) {
			return in * 2, nil
		}

		transform := func(val any) any {
			return map[string]any{"transformed": val}
		}

		wrapped := core.EmitOnSuccess(
			queue,
			"OrderCreated",
			op,
			core.WithEmitMetadata(meta),
			core.WithEmitTransform(transform),
		)

		res, err := wrapped(ctx, 21)
		if err != nil || res != 42 {
			t.Fatalf("unexpected res %d, err %v", res, err)
		}

		msgs := queue.Messages()
		if len(msgs) != 1 {
			t.Fatalf("expected 1 message, got %d", len(msgs))
		}

		msg := msgs[0]
		if msg.EventName != "OrderCreated" {
			t.Errorf("expected EventName 'OrderCreated', got %q", msg.EventName)
		}
		if msg.Metadata == nil || msg.Metadata.ClassName != "OrderService" {
			t.Errorf("expected metadata ClassName 'OrderService', got %#v", msg.Metadata)
		}
		if msg.Metadata.Topic == nil || *msg.Metadata.Topic != "orders.created" {
			t.Errorf("expected topic 'orders.created', got %v", msg.Metadata.Topic)
		}

		payload, ok := msg.Payload.(map[string]any)
		if !ok || payload["transformed"] != 42 {
			t.Errorf("expected transformed payload with 42, got %#v", msg.Payload)
		}
	})
}

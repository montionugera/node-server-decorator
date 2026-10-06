package core_test

import (
	"context"
	"sync"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/core"
)

type recordingQueue struct {
	mu   sync.Mutex
	msgs []core.QueueMessage
}

func (q *recordingQueue) Publish(_ context.Context, msg core.QueueMessage) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.msgs = append(q.msgs, msg)
	return nil
}

// A transform that panics must not turn a successful call into a panic for the
// caller; the result is returned and nothing is published.
func TestEmitOnSuccessPanickingTransformDoesNotFailCaller(t *testing.T) {
	queue := &recordingQueue{}
	save := func(_ context.Context, id int) (map[string]any, error) {
		return map[string]any{"id": id}, nil
	}
	wrapped := core.EmitOnSuccess(queue, "Svc.save", save,
		core.WithEmitTransform(func(v any) any {
			return v.(map[string]any)["missing"].(string)
		}),
	)

	out, err := wrapped(context.Background(), 7)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out["id"] != 7 {
		t.Fatalf("expected original result, got %v", out)
	}
	if len(queue.msgs) != 0 {
		t.Fatalf("expected nothing published, got %d message(s)", len(queue.msgs))
	}
}

func TestEmitOnSuccessTransformStillApplied(t *testing.T) {
	queue := &recordingQueue{}
	wrapped := core.EmitOnSuccess(queue, "Svc.save",
		func(_ context.Context, id int) (int, error) { return id, nil },
		core.WithEmitTransform(func(v any) any { return v.(int) * 2 }),
	)

	if _, err := wrapped(context.Background(), 21); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(queue.msgs) != 1 || queue.msgs[0].Payload != 42 {
		t.Fatalf("expected one message with payload 42, got %+v", queue.msgs)
	}
}

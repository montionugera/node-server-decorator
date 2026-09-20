package tracing_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/core"
	"github.com/montionugera/node-server-decorator/v2/go/core/tracing"
)

type fixtureCase struct {
	Traceparent string `json:"traceparent"`
	Valid       bool   `json:"valid"`
	TraceID     string `json:"traceId"`
	SpanID      string `json:"spanId"`
	Sampled     bool   `json:"sampled"`
}

func loadFixtures(t *testing.T) []fixtureCase {
	_, b, _, _ := runtime.Caller(0)
	basepath := filepath.Dir(b)
	root := filepath.Join(basepath, "..", "..", "..")
	fixturesPath := filepath.Join(root, "contracts", "fixtures", "trace-context.cases.json")

	data, err := os.ReadFile(fixturesPath)
	if err != nil {
		t.Fatalf("failed to read fixtures: %v", err)
	}

	var cases []fixtureCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("failed to unmarshal fixtures: %v", err)
	}
	return cases
}

func TestW3CCarrierParsingAndFormatting(t *testing.T) {
	cases := loadFixtures(t)
	for _, tc := range cases {
		t.Run(tc.Traceparent, func(t *testing.T) {
			parsed, err := tracing.ParseTraceparent(tc.Traceparent)
			if tc.Valid {
				if err != nil {
					t.Fatalf("expected valid for %s, got error: %v", tc.Traceparent, err)
				}
				if parsed.TraceID != tc.TraceID {
					t.Errorf("expected TraceID %s, got %s", tc.TraceID, parsed.TraceID)
				}
				if parsed.SpanID != tc.SpanID {
					t.Errorf("expected SpanID %s, got %s", tc.SpanID, parsed.SpanID)
				}
				if parsed.Sampled != tc.Sampled {
					t.Errorf("expected Sampled %v, got %v", tc.Sampled, parsed.Sampled)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error for invalid traceparent: %s", tc.Traceparent)
				}
			}
		})
	}

	t.Run("FormatTraceparent", func(t *testing.T) {
		res := tracing.FormatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", true)
		expected := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
		if res != expected {
			t.Errorf("expected %s, got %s", expected, res)
		}
	})
}

func TestTracingDecorator(t *testing.T) {
	var mu sync.Mutex
	var spans []tracing.Span
	tracing.SetSpanExporter(func(s tracing.Span) {
		mu.Lock()
		defer mu.Unlock()
		spans = append(spans, s)
	})
	defer tracing.SetSpanExporter(nil)

	t.Run("creates active span and records attributes", func(t *testing.T) {
		mu.Lock()
		spans = nil
		mu.Unlock()

		fn := tracing.Trace("users.get", func(ctx context.Context, id string) (string, error) {
			tc, ok := tracing.FromContext(ctx)
			if !ok {
				t.Fatalf("expected active trace context")
			}
			if len(tc.TraceID) != 32 {
				t.Errorf("unexpected traceID length: %d", len(tc.TraceID))
			}
			return "user-" + id, nil
		}, tracing.WithAttribute("service.name", "user-service"))

		res, err := fn(context.Background(), "123")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res != "user-123" {
			t.Errorf("unexpected result: %s", res)
		}

		mu.Lock()
		defer mu.Unlock()
		if len(spans) != 1 {
			t.Fatalf("expected 1 span, got %d", len(spans))
		}
		if spans[0].Name != "users.get" {
			t.Errorf("unexpected span name: %s", spans[0].Name)
		}
		if spans[0].Attributes["service.name"] != "user-service" {
			t.Errorf("attribute not found: %v", spans[0].Attributes)
		}
		if spans[0].Status != "OK" {
			t.Errorf("expected OK status, got %s", spans[0].Status)
		}
	})

	t.Run("propagates parent span context across nested calls", func(t *testing.T) {
		mu.Lock()
		spans = nil
		mu.Unlock()

		childFn := tracing.Trace("child.op", func(ctx context.Context, _ int) (string, error) {
			return "done", nil
		})

		parentFn := tracing.Trace("parent.op", func(ctx context.Context, in int) (string, error) {
			return childFn(ctx, in)
		})

		_, _ = parentFn(context.Background(), 1)

		mu.Lock()
		defer mu.Unlock()
		if len(spans) != 2 {
			t.Fatalf("expected 2 spans, got %d", len(spans))
		}

		var parentSpan, childSpan tracing.Span
		for _, s := range spans {
			if s.Name == "parent.op" {
				parentSpan = s
			} else if s.Name == "child.op" {
				childSpan = s
			}
		}

		if childSpan.TraceID != parentSpan.TraceID {
			t.Errorf("child traceID %s != parent traceID %s", childSpan.TraceID, parentSpan.TraceID)
		}
		if childSpan.ParentSpanID != parentSpan.SpanID {
			t.Errorf("child parentSpanID %s != parent spanID %s", childSpan.ParentSpanID, parentSpan.SpanID)
		}
	})

	t.Run("records error details on failed span", func(t *testing.T) {
		mu.Lock()
		spans = nil
		mu.Unlock()

		fn := tracing.Trace("failing.op", func(ctx context.Context, _ string) (string, error) {
			return "", errors.New("timeout reached")
		})

		_, err := fn(context.Background(), "test")
		if err == nil {
			t.Fatalf("expected error")
		}

		mu.Lock()
		defer mu.Unlock()
		if len(spans) != 1 {
			t.Fatalf("expected 1 span, got %d", len(spans))
		}
		if spans[0].Status != "ERROR" {
			t.Errorf("expected status ERROR, got %s", spans[0].Status)
		}
		if !strings.Contains(spans[0].Attributes["exception.message"].(string), "timeout reached") {
			t.Errorf("exception message not recorded: %v", spans[0].Attributes)
		}
	})
}

type inMemoryAdapter struct {
	mu       sync.Mutex
	messages []core.QueueMessage
}

func (a *inMemoryAdapter) Publish(ctx context.Context, msg core.QueueMessage) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.messages = append(a.messages, msg)
	return nil
}

func TestEmitOnSuccessTracePropagation(t *testing.T) {
	adapter := &inMemoryAdapter{}

	emitFn := core.EmitOnSuccess[string, string](
		adapter,
		"order.created",
		func(ctx context.Context, id string) (string, error) {
			return "ord-" + id, nil
		},
	)

	tracedEmit := tracing.Trace("orders.create", emitFn)

	_, err := tracedEmit(context.Background(), "456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	adapter.mu.Lock()
	defer adapter.mu.Unlock()
	if len(adapter.messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(adapter.messages))
	}

	msg := adapter.messages[0]
	if msg.Metadata == nil || msg.Metadata.Traceparent == "" {
		t.Fatalf("expected Traceparent in message metadata")
	}

	parsed, err := tracing.ParseTraceparent(msg.Metadata.Traceparent)
	if err != nil {
		t.Fatalf("failed to parse traceparent: %v", err)
	}
	if len(parsed.TraceID) != 32 {
		t.Errorf("invalid traceID in metadata: %s", parsed.TraceID)
	}
}

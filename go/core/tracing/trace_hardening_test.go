package tracing_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/core/tracing"
)

func TestParseTraceparentStrictness(t *testing.T) {
	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	const spanID = "00f067aa0ba902b7"
	invalid := []string{
		"01-" + traceID + "-" + spanID + "-01",
		"cc-" + strings.Repeat("0", 32) + "-" + strings.Repeat("0", 16) + "-01",
		"cc-" + strings.Repeat("0", 32) + "-" + spanID + "-01",
		"00-" + strings.ToUpper(traceID) + "-" + spanID + "-01",
	}
	for _, header := range invalid {
		if tc, err := tracing.ParseTraceparent(header); err == nil {
			t.Errorf("expected error for %s, got %+v", header, tc)
		}
	}
}

func TestTracePanicExportsErrorSpan(t *testing.T) {
	var mu sync.Mutex
	var spans []tracing.Span
	tracing.SetSpanExporter(func(s tracing.Span) {
		mu.Lock()
		defer mu.Unlock()
		spans = append(spans, s)
	})
	defer tracing.SetSpanExporter(nil)

	traced := tracing.Trace("panicky", func(ctx context.Context, in string) (string, error) {
		panic("boom " + in)
	})

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_, _ = traced(context.Background(), "x")
	}()

	if recovered != "boom x" {
		t.Fatalf("expected the original panic value to propagate, got %v", recovered)
	}
	if len(spans) != 1 {
		t.Fatalf("expected 1 exported span, got %d", len(spans))
	}
	if spans[0].Name != "panicky" || spans[0].Status != "ERROR" {
		t.Errorf("expected panicky/ERROR, got %s/%s", spans[0].Name, spans[0].Status)
	}
	if msg, _ := spans[0].Attributes["exception.message"].(string); !strings.Contains(msg, "boom x") {
		t.Errorf("expected exception.message to mention the panic value, got %q", msg)
	}
}

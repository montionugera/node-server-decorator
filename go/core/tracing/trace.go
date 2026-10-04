package tracing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// traceparentRegex matches 00-traceid-spanid-flags per W3C Trace Context spec.
var traceparentRegex = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`)

// TraceContext represents the active W3C trace propagation state.
type TraceContext struct {
	TraceID      string
	SpanID       string
	ParentSpanID string
	Sampled      bool
	Tracestate   string
}

// Span records an active execution unit compatible with OpenTelemetry models.
type Span struct {
	Name         string
	TraceID      string
	SpanID       string
	ParentSpanID string
	Sampled      bool
	Attributes   map[string]any
	StartTime    time.Time
	EndTime      time.Time
	Duration     time.Duration
	Status       string // "OK" | "ERROR"
}

type contextKey struct{}

var traceKey = contextKey{}

var (
	exporterMu sync.RWMutex
	exporter   func(Span)
)

// SetSpanExporter registers a global callback for finished spans.
func SetSpanExporter(fn func(Span)) {
	exporterMu.Lock()
	defer exporterMu.Unlock()
	exporter = fn
}

// WithTraceContext injects a TraceContext into the standard context.Context.
func WithTraceContext(ctx context.Context, tc TraceContext) context.Context {
	return context.WithValue(ctx, traceKey, tc)
}

// FromContext extracts the active TraceContext from context.Context, if any.
func FromContext(ctx context.Context) (TraceContext, bool) {
	if ctx == nil {
		return TraceContext{}, false
	}
	tc, ok := ctx.Value(traceKey).(TraceContext)
	return tc, ok
}

// ParseTraceparent parses a W3C traceparent header string.
func ParseTraceparent(header string) (*TraceContext, error) {
	header = strings.TrimSpace(header)
	matches := traceparentRegex.FindStringSubmatch(header)
	if len(matches) != 5 {
		return nil, fmt.Errorf("invalid traceparent header: %s", header)
	}

	version := matches[1]
	traceID := matches[2]
	spanID := matches[3]
	flags := matches[4]

	// contracts/rules/trace-context.md: version must be exactly 00.
	if version != "00" {
		return nil, fmt.Errorf("invalid traceparent version %s", version)
	}

	// All-zeros trace_id or span_id is always invalid.
	if traceID == strings.Repeat("0", 32) || spanID == strings.Repeat("0", 16) {
		return nil, fmt.Errorf("invalid traceparent: trace_id and span_id must not be all zeros")
	}

	var flagByte byte
	_, _ = fmt.Sscanf(flags, "%x", &flagByte)
	sampled := (flagByte & 0x01) == 1

	return &TraceContext{
		TraceID: traceID,
		SpanID:  spanID,
		Sampled: sampled,
	}, nil
}

// FormatTraceparent formats trace ID, span ID, and sampled flag into a W3C header.
func FormatTraceparent(traceID, spanID string, sampled bool) string {
	flags := "00"
	if sampled {
		flags = "01"
	}
	return fmt.Sprintf("00-%s-%s-%s", traceID, spanID, flags)
}

func randomHex(byteLen int) string {
	b := make([]byte, byteLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// SpanOption configures span options.
type SpanOption func(*spanConfig)

type spanConfig struct {
	attributes map[string]any
}

// WithAttribute adds a key-value attribute to the span.
func WithAttribute(key string, value any) SpanOption {
	return func(cfg *spanConfig) {
		if cfg.attributes == nil {
			cfg.attributes = make(map[string]any)
		}
		cfg.attributes[key] = value
	}
}

// WithAttributes adds multiple attributes to the span.
func WithAttributes(attrs map[string]any) SpanOption {
	return func(cfg *spanConfig) {
		if cfg.attributes == nil {
			cfg.attributes = make(map[string]any)
		}
		for k, v := range attrs {
			cfg.attributes[k] = v
		}
	}
}

// StartSpan creates a child span or new root span, returning a new context and end function.
func StartSpan(ctx context.Context, name string, opts ...SpanOption) (context.Context, func(err error)) {
	var cfg spanConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	if cfg.attributes == nil {
		cfg.attributes = make(map[string]any)
	}

	parentTC, hasParent := FromContext(ctx)
	traceID := parentTC.TraceID
	parentSpanID := ""
	sampled := true

	if hasParent && traceID != "" {
		parentSpanID = parentTC.SpanID
		sampled = parentTC.Sampled
	} else {
		traceID = randomHex(16)
	}

	spanID := randomHex(8)
	currentTC := TraceContext{
		TraceID:      traceID,
		SpanID:       spanID,
		ParentSpanID: parentSpanID,
		Sampled:      sampled,
		Tracestate:   parentTC.Tracestate,
	}

	startTime := time.Now()
	newCtx := WithTraceContext(ctx, currentTC)

	end := func(err error) {
		endTime := time.Now()
		duration := endTime.Sub(startTime)
		status := "OK"
		if err != nil {
			status = "ERROR"
			cfg.attributes["exception.type"] = fmt.Sprintf("%T", err)
			cfg.attributes["exception.message"] = err.Error()
		}

		span := Span{
			Name:         name,
			TraceID:      traceID,
			SpanID:       spanID,
			ParentSpanID: parentSpanID,
			Sampled:      sampled,
			Attributes:   cfg.attributes,
			StartTime:    startTime,
			EndTime:      endTime,
			Duration:     duration,
			Status:       status,
		}

		exporterMu.RLock()
		exp := exporter
		exporterMu.RUnlock()

		if exp != nil {
			exp(span)
		}
	}

	return newCtx, end
}

// Trace wraps an existing function with span instrumentation.
func Trace[In, Out any](
	name string,
	fn func(context.Context, In) (Out, error),
	opts ...SpanOption,
) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (out Out, err error) {
		spanCtx, end := StartSpan(ctx, name, opts...)
		// Deferred so a panic in fn still ends and exports the span (as ERROR)
		// before the panic continues to unwind.
		defer func() {
			if r := recover(); r != nil {
				end(fmt.Errorf("panic: %v", r))
				panic(r)
			}
			end(err)
		}()
		return fn(spanCtx, in)
	}
}

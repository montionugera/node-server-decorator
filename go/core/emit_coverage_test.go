package core_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core"
	"github.com/montionugera/node-server-decorator/v2/go/core/tracing"
)

type emitCovEmitQueue struct {
	mu   sync.Mutex
	msgs []core.QueueMessage
	err  error
}

func (q *emitCovEmitQueue) Publish(_ context.Context, msg core.QueueMessage) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.msgs = append(q.msgs, msg)
	return q.err
}

func (q *emitCovEmitQueue) only(t *testing.T) core.QueueMessage {
	t.Helper()
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.msgs) != 1 {
		t.Fatalf("published %d messages, want exactly 1", len(q.msgs))
	}
	return q.msgs[0]
}

const (
	emitCovTraceID = "0af7651916cd43dd8448eb211c80319c"
	emitCovSpanID  = "b7ad6b7169203331"
)

func emitCovDouble(_ context.Context, in int) (int, error) { return in * 2, nil }

func TestEmitOnSuccessPublishesResultWithTimestamp(t *testing.T) {
	q := &emitCovEmitQueue{}
	wrapped := core.EmitOnSuccess(q, "num.doubled", emitCovDouble)

	before := time.Now().UnixMilli()
	out, err := wrapped(context.Background(), 21)
	after := time.Now().UnixMilli()
	if err != nil || out != 42 {
		t.Fatalf("wrapped returned (%d, %v), want (42, nil)", out, err)
	}

	msg := q.only(t)
	if msg.EventName != "num.doubled" || msg.Payload != 42 {
		t.Fatalf("message = %+v, want eventName num.doubled and payload 42", msg)
	}
	if msg.Timestamp < before || msg.Timestamp > after {
		t.Fatalf("timestamp %d outside call window [%d, %d]", msg.Timestamp, before, after)
	}
	if msg.Metadata != nil {
		t.Fatalf("metadata = %+v, want nil without options or trace context", msg.Metadata)
	}
}

func TestEmitOnSuccessDoesNotPublishOnError(t *testing.T) {
	q := &emitCovEmitQueue{}
	boom := errors.New("boom")
	wrapped := core.EmitOnSuccess(q, "evt", func(context.Context, int) (int, error) { return 7, boom })

	out, err := wrapped(context.Background(), 1)
	if !errors.Is(err, boom) || out != 7 {
		t.Fatalf("wrapped returned (%d, %v), want fn's own (7, boom)", out, err)
	}
	if len(q.msgs) != 0 {
		t.Fatalf("published %d messages for a failed call, want 0", len(q.msgs))
	}
}

func TestEmitOnSuccessSwallowsPublishError(t *testing.T) {
	q := &emitCovEmitQueue{err: errors.New("broker down")}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble)

	out, err := wrapped(context.Background(), 2)
	if err != nil || out != 4 {
		t.Fatalf("wrapped returned (%d, %v), want (4, nil): a publish failure must not fail the call", out, err)
	}
	q.only(t)
}

func TestEmitOnSuccessNilAdapterStillReturnsResult(t *testing.T) {
	wrapped := core.EmitOnSuccess[int, int](nil, "evt", emitCovDouble)
	out, err := wrapped(context.Background(), 5)
	if err != nil || out != 10 {
		t.Fatalf("wrapped returned (%d, %v), want (10, nil)", out, err)
	}
}

func TestEmitOnSuccessInjectsTraceContextWhenNoMetadata(t *testing.T) {
	q := &emitCovEmitQueue{}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble)
	ctx := tracing.WithTraceContext(context.Background(), tracing.TraceContext{
		TraceID: emitCovTraceID, SpanID: emitCovSpanID, Sampled: true, Tracestate: "vendor=1",
	})

	if _, err := wrapped(ctx, 1); err != nil {
		t.Fatal(err)
	}
	meta := q.only(t).Metadata
	if meta == nil {
		t.Fatal("metadata is nil, want trace headers injected")
	}
	if want := "00-" + emitCovTraceID + "-" + emitCovSpanID + "-01"; meta.Traceparent != want {
		t.Fatalf("traceparent = %q, want %q", meta.Traceparent, want)
	}
	if meta.Tracestate != "vendor=1" {
		t.Fatalf("tracestate = %q, want vendor=1", meta.Tracestate)
	}
	if meta.ClassName != "" || meta.Topic != nil {
		t.Fatalf("unexpected non-trace metadata: %+v", meta)
	}
}

func TestEmitOnSuccessUnsampledTraceWithoutTracestate(t *testing.T) {
	q := &emitCovEmitQueue{}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble)
	ctx := tracing.WithTraceContext(context.Background(), tracing.TraceContext{TraceID: emitCovTraceID, SpanID: emitCovSpanID})

	if _, err := wrapped(ctx, 1); err != nil {
		t.Fatal(err)
	}
	meta := q.only(t).Metadata
	if meta == nil || meta.Traceparent != "00-"+emitCovTraceID+"-"+emitCovSpanID+"-00" {
		t.Fatalf("metadata = %+v, want unsampled traceparent", meta)
	}
	if meta.Tracestate != "" {
		t.Fatalf("tracestate = %q, want empty", meta.Tracestate)
	}
}

func TestEmitOnSuccessMergesTraceIntoCopyOfMetadata(t *testing.T) {
	q := &emitCovEmitQueue{}
	topic := "users"
	shared := &core.QueueMessageMetadata{ClassName: "UserSvc", MethodName: "create", Topic: &topic, Service: "api"}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble, core.WithEmitMetadata(shared))
	ctx := tracing.WithTraceContext(context.Background(), tracing.TraceContext{
		TraceID: emitCovTraceID, SpanID: emitCovSpanID, Sampled: true, Tracestate: "vendor=1",
	})

	if _, err := wrapped(ctx, 1); err != nil {
		t.Fatal(err)
	}
	meta := q.only(t).Metadata
	if meta == shared {
		t.Fatal("published metadata aliases the shared options struct; per-call trace data would leak across calls")
	}
	if meta.ClassName != "UserSvc" || meta.MethodName != "create" || meta.Service != "api" || meta.Topic == nil || *meta.Topic != "users" {
		t.Fatalf("configured metadata lost: %+v", meta)
	}
	if meta.Traceparent != "00-"+emitCovTraceID+"-"+emitCovSpanID+"-01" || meta.Tracestate != "vendor=1" {
		t.Fatalf("trace headers not merged: %+v", meta)
	}
	if shared.Traceparent != "" || shared.Tracestate != "" {
		t.Fatalf("shared metadata was mutated: %+v", shared)
	}
}

func TestEmitOnSuccessKeepsExplicitTraceHeaders(t *testing.T) {
	q := &emitCovEmitQueue{}
	explicit := &core.QueueMessageMetadata{Traceparent: "00-explicit-parent-01", Tracestate: "explicit=1"}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble, core.WithEmitMetadata(explicit))
	ctx := tracing.WithTraceContext(context.Background(), tracing.TraceContext{
		TraceID: emitCovTraceID, SpanID: emitCovSpanID, Sampled: true, Tracestate: "vendor=1",
	})

	if _, err := wrapped(ctx, 1); err != nil {
		t.Fatal(err)
	}
	meta := q.only(t).Metadata
	if meta.Traceparent != "00-explicit-parent-01" || meta.Tracestate != "explicit=1" {
		t.Fatalf("explicit trace headers were overwritten: %+v", meta)
	}
}

func TestEmitOnSuccessIgnoresTraceContextWithoutTraceID(t *testing.T) {
	q := &emitCovEmitQueue{}
	shared := &core.QueueMessageMetadata{Service: "api"}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble, core.WithEmitMetadata(shared))
	ctx := tracing.WithTraceContext(context.Background(), tracing.TraceContext{SpanID: emitCovSpanID, Tracestate: "vendor=1"})

	if _, err := wrapped(ctx, 1); err != nil {
		t.Fatal(err)
	}
	meta := q.only(t).Metadata
	if meta != shared {
		t.Fatalf("metadata = %+v, want the configured metadata passed through untouched", meta)
	}
	if meta.Traceparent != "" || meta.Tracestate != "" {
		t.Fatalf("trace headers injected from a context with no trace id: %+v", meta)
	}
}

func TestEmitOnSuccessTransformReplacesPayloadOnly(t *testing.T) {
	q := &emitCovEmitQueue{}
	wrapped := core.EmitOnSuccess(q, "evt", emitCovDouble, core.WithEmitTransform(func(v any) any {
		return map[string]any{"value": v}
	}))

	out, err := wrapped(context.Background(), 3)
	if err != nil || out != 6 {
		t.Fatalf("wrapped returned (%d, %v), want the untransformed (6, nil)", out, err)
	}
	payload, ok := q.only(t).Payload.(map[string]any)
	if !ok || payload["value"] != 6 {
		t.Fatalf("payload = %#v, want map with value 6", q.msgs[0].Payload)
	}
}

package core

import (
	"context"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core/tracing"
)

// QueueMessageMetadata matches the metadata structure specified in
// contracts/schemas/queue-message.schema.json.
type QueueMessageMetadata struct {
	ClassName   string  `json:"className,omitempty"`
	MethodName  string  `json:"methodName,omitempty"`
	Topic       *string `json:"topic,omitempty"`
	Service     string  `json:"service,omitempty"`
	Traceparent string  `json:"traceparent,omitempty"`
	Tracestate  string  `json:"tracestate,omitempty"`
}

// QueueMessage matches the wire format defined in
// contracts/schemas/queue-message.schema.json.
type QueueMessage struct {
	EventName string                `json:"eventName"`
	Payload   any                   `json:"payload"`
	Timestamp int64                 `json:"timestamp"`
	Metadata  *QueueMessageMetadata `json:"metadata,omitempty"`
}

// QueueAdapter defines the interface for publishing messages to an underlying queue or topic.
type QueueAdapter interface {
	Publish(ctx context.Context, msg QueueMessage) error
}

// EmitOption configures optional behavior for EmitOnSuccess.
type EmitOption func(*emitOptions)

type emitOptions struct {
	metadata  *QueueMessageMetadata
	transform func(any) any
}

// WithEmitMetadata specifies metadata to attach to published QueueMessages.
func WithEmitMetadata(meta *QueueMessageMetadata) EmitOption {
	return func(o *emitOptions) {
		o.metadata = meta
	}
}

// WithEmitTransform specifies a transform function applied to the return payload before emitting.
func WithEmitTransform(transform func(any) any) EmitOption {
	return func(o *emitOptions) {
		o.transform = transform
	}
}

// applyEmitTransform runs the optional transform, reporting ok=false if it panicked.
func applyEmitTransform(transform func(any) any, out any) (payload any, ok bool) {
	if transform == nil {
		return out, true
	}
	defer func() {
		if recover() != nil {
			payload, ok = nil, false
		}
	}()
	return transform(out), true
}

// EmitOnSuccess wraps a function so that upon successful execution (no error returned),
// a QueueMessage is constructed with Timestamp = time.Now().UnixMilli() and published
// to the provided QueueAdapter. If fn returns an error, no message is published.
func EmitOnSuccess[In, Out any](
	adapter QueueAdapter,
	eventName string,
	fn func(context.Context, In) (Out, error),
	opts ...EmitOption,
) func(context.Context, In) (Out, error) {
	var cfg emitOptions
	for _, opt := range opts {
		opt(&cfg)
	}

	return func(ctx context.Context, in In) (Out, error) {
		out, err := fn(ctx, in)
		if err != nil {
			return out, err
		}

		// fn already succeeded: a panicking transform must not change its outcome
		// (Node/Python parity). Skip emission instead of panicking into the caller.
		payload, ok := applyEmitTransform(cfg.transform, out)
		if !ok {
			return out, nil
		}

		meta := cfg.metadata
		if tc, ok := tracing.FromContext(ctx); ok && tc.TraceID != "" {
			var m QueueMessageMetadata
			if meta != nil {
				m = *meta
			}
			if m.Traceparent == "" {
				m.Traceparent = tracing.FormatTraceparent(tc.TraceID, tc.SpanID, tc.Sampled)
			}
			if m.Tracestate == "" && tc.Tracestate != "" {
				m.Tracestate = tc.Tracestate
			}
			meta = &m
		}

		msg := QueueMessage{
			EventName: eventName,
			Payload:   payload,
			Timestamp: time.Now().UnixMilli(),
			Metadata:  meta,
		}

		if adapter != nil {
			_ = adapter.Publish(ctx, msg)
		}

		return out, nil
	}
}

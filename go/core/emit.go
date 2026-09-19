package core

import (
	"context"
	"time"
)

// QueueMessageMetadata matches the metadata structure specified in
// contracts/schemas/queue-message.schema.json.
type QueueMessageMetadata struct {
	ClassName  string  `json:"className,omitempty"`
	MethodName string  `json:"methodName,omitempty"`
	Topic      *string `json:"topic,omitempty"`
	Service    string  `json:"service,omitempty"`
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

		payload := any(out)
		if cfg.transform != nil {
			payload = cfg.transform(out)
		}

		msg := QueueMessage{
			EventName: eventName,
			Payload:   payload,
			Timestamp: time.Now().UnixMilli(),
			Metadata:  cfg.metadata,
		}

		if adapter != nil {
			_ = adapter.Publish(ctx, msg)
		}

		return out, nil
	}
}

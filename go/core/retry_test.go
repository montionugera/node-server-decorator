package core

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestRetry_SuccessImmediate(t *testing.T) {
	ctx := context.Background()
	var calls int32

	fn := func(ctx context.Context, in int) (string, error) {
		atomic.AddInt32(&calls, 1)
		return "ok", nil
	}

	opts := DefaultRetryOptions()
	wrapped := Retry(opts, fn)

	res, err := wrapped(ctx, 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != "ok" {
		t.Fatalf("expected 'ok', got %s", res)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected 1 call, got %d", calls)
	}
}

func TestRetry_SuccessAfterRetries(t *testing.T) {
	ctx := context.Background()
	var calls int32

	fn := func(ctx context.Context, in int) (int, error) {
		c := atomic.AddInt32(&calls, 1)
		if c < 3 {
			return 0, errors.New("temporary failure")
		}
		return in * 2, nil
	}

	opts := RetryOptions{
		MaxAttempts:     4,
		InitialInterval: 5 * time.Millisecond,
		MaxInterval:     20 * time.Millisecond,
		Multiplier:      2.0,
		Jitter:          false,
	}
	wrapped := Retry(opts, fn)

	res, err := wrapped(ctx, 21)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res != 42 {
		t.Fatalf("expected 42, got %d", res)
	}
	if atomic.LoadInt32(&calls) != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry_ExhaustAttempts(t *testing.T) {
	ctx := context.Background()
	var calls int32
	expectedErr := errors.New("fatal")

	fn := func(ctx context.Context, in string) (string, error) {
		atomic.AddInt32(&calls, 1)
		return "", expectedErr
	}

	opts := RetryOptions{
		MaxAttempts:     3,
		InitialInterval: 2 * time.Millisecond,
		MaxInterval:     10 * time.Millisecond,
		Multiplier:      2.0,
		Jitter:          false,
	}
	wrapped := Retry(opts, fn)

	_, err := wrapped(ctx, "test")
	if !errors.Is(err, expectedErr) {
		t.Fatalf("expected %v, got %v", expectedErr, err)
	}
	if atomic.LoadInt32(&calls) != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestRetry_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls int32

	fn := func(ctx context.Context, in int) (int, error) {
		atomic.AddInt32(&calls, 1)
		cancel() // cancel during first call
		return 0, errors.New("err")
	}

	opts := RetryOptions{
		MaxAttempts:     5,
		InitialInterval: 50 * time.Millisecond,
		MaxInterval:     200 * time.Millisecond,
		Multiplier:      2.0,
	}
	wrapped := Retry(opts, fn)

	_, err := wrapped(ctx, 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected 1 call before cancel, got %d", calls)
	}
}

func TestRetry_Predicate(t *testing.T) {
	ctx := context.Background()
	var calls int32
	retryableErr := errors.New("retryable")
	fatalErr := errors.New("non-retryable")

	fn := func(ctx context.Context, in int) (int, error) {
		atomic.AddInt32(&calls, 1)
		return 0, fatalErr
	}

	opts := RetryOptions{
		MaxAttempts:     3,
		InitialInterval: 2 * time.Millisecond,
		RetryIf: func(err error) bool {
			return errors.Is(err, retryableErr)
		},
	}
	wrapped := Retry(opts, fn)

	_, err := wrapped(ctx, 1)
	if !errors.Is(err, fatalErr) {
		t.Fatalf("expected fatalErr, got %v", err)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected 1 call due to predicate, got %d", calls)
	}
}

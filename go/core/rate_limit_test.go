package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTokenBucketLimiter_BurstAndRefill(t *testing.T) {
	// Capacity of 3, refill rate 10/sec (1 token per 100ms)
	limiter := NewTokenBucketLimiter(3, 10)

	if !limiter.Allow(1) {
		t.Fatalf("call 1 should succeed")
	}
	if !limiter.Allow(1) {
		t.Fatalf("call 2 should succeed")
	}
	if !limiter.Allow(1) {
		t.Fatalf("call 3 should succeed")
	}

	// 4th call should be rejected (exhausted)
	if limiter.Allow(1) {
		t.Fatalf("call 4 should be rejected when bucket is empty")
	}

	// Wait 120ms for refill of at least 1 token
	time.Sleep(120 * time.Millisecond)

	if !limiter.Allow(1) {
		t.Fatalf("call after refill should succeed")
	}
}

func TestRateLimit_Wrapper(t *testing.T) {
	ctx := context.Background()
	limiter := NewTokenBucketLimiter(2, 5)

	fn := func(ctx context.Context, in int) (int, error) {
		return in * 10, nil
	}

	wrapped := RateLimit(limiter, fn)

	res, err := wrapped(ctx, 1)
	if err != nil || res != 10 {
		t.Fatalf("call 1 failed: %v", err)
	}

	res, err = wrapped(ctx, 2)
	if err != nil || res != 20 {
		t.Fatalf("call 2 failed: %v", err)
	}

	// Call 3 should fail with ErrRateLimitExceeded
	_, err = wrapped(ctx, 3)
	if !errors.Is(err, ErrRateLimitExceeded) {
		t.Fatalf("expected ErrRateLimitExceeded, got %v", err)
	}
}

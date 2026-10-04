package core

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestCircuitBreaker_StateTransitions(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		Name:                     "test-service",
		FailureThreshold:         3,
		RecoveryTimeout:          50 * time.Millisecond,
		HalfOpenSuccessThreshold: 2,
	})

	if cb.State() != StateClosed {
		t.Fatalf("expected initial StateClosed, got %v", cb.State())
	}

	// 2 failures: still closed
	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != StateClosed {
		t.Fatalf("expected StateClosed after 2 failures, got %v", cb.State())
	}

	// 3rd failure trips to Open
	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Fatalf("expected StateOpen after 3 failures, got %v", cb.State())
	}
	if cb.AllowRequest() {
		t.Fatalf("expected requests to be blocked when Open")
	}

	// Wait for recovery timeout
	time.Sleep(60 * time.Millisecond)
	if cb.State() != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen after recovery timeout, got %v", cb.State())
	}
	if !cb.AllowRequest() {
		t.Fatalf("expected requests allowed when HalfOpen")
	}

	// First trial success: still HalfOpen
	cb.RecordSuccess()
	if cb.State() != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen after 1 success, got %v", cb.State())
	}

	// Second trial success: recovers to Closed!
	if !cb.AllowRequest() {
		t.Fatalf("expected requests allowed when HalfOpen")
	}
	cb.RecordSuccess()
	if cb.State() != StateClosed {
		t.Fatalf("expected StateClosed after 2 successes, got %v", cb.State())
	}
}

func TestCircuitBreaker_HalfOpenFailureTripsImmediately(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         2,
		RecoveryTimeout:          20 * time.Millisecond,
		HalfOpenSuccessThreshold: 2,
	})

	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Fatalf("expected Open")
	}

	time.Sleep(30 * time.Millisecond)
	if cb.State() != StateHalfOpen {
		t.Fatalf("expected HalfOpen")
	}

	// Failure during half-open trips immediately to Open
	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Fatalf("expected immediate transition back to Open, got %v", cb.State())
	}
}

func TestCircuitBreaker_WrapperAndFallback(t *testing.T) {
	ctx := context.Background()
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold: 2,
		RecoveryTimeout:  100 * time.Millisecond,
	})

	var calls int32
	failingFn := func(ctx context.Context, in string) (string, error) {
		atomic.AddInt32(&calls, 1)
		return "", errors.New("upstream error")
	}

	fallback := func(ctx context.Context, in string, err error) (string, error) {
		return "fallback-response", nil
	}

	wrapped := CircuitBreakerWrapper(cb, fallback, failingFn)

	// Call 1: fails and uses fallback
	res, err := wrapped(ctx, "req1")
	if err != nil || res != "fallback-response" {
		t.Fatalf("expected fallback response, got %s, err %v", res, err)
	}

	// Call 2: fails and trips breaker
	wrapped(ctx, "req2")
	if cb.State() != StateOpen {
		t.Fatalf("expected breaker to be Open")
	}

	// Call 3: rejected by open circuit, fallback called without calling failingFn
	beforeCalls := atomic.LoadInt32(&calls)
	res, err = wrapped(ctx, "req3")
	if err != nil || res != "fallback-response" {
		t.Fatalf("expected fallback response, got %s, err %v", res, err)
	}
	if atomic.LoadInt32(&calls) != beforeCalls {
		t.Fatalf("failingFn should not have been called while Open")
	}
}

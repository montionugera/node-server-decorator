package core

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRetry_NegativeMaxAttemptsPanicsAtWrapTime(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected Retry to panic on a negative MaxAttempts")
		}
	}()
	Retry(RetryOptions{MaxAttempts: -1}, func(ctx context.Context, in int) (int, error) {
		return in, nil
	})
}

func TestRetry_ZeroMaxAttemptsMeansDefaultThree(t *testing.T) {
	var calls int32
	boom := errors.New("boom")
	fn := Retry(RetryOptions{InitialInterval: time.Microsecond, MaxInterval: time.Microsecond},
		func(ctx context.Context, in int) (int, error) {
			atomic.AddInt32(&calls, 1)
			return 0, boom
		})
	if _, err := fn(context.Background(), 1); !errors.Is(err, boom) {
		t.Fatalf("expected the method's error to propagate, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 attempts for the zero value, got %d", got)
	}
}

func TestRetry_MaxAttemptsOneRunsOnceAndPropagates(t *testing.T) {
	var calls int32
	boom := errors.New("boom")
	fn := Retry(RetryOptions{MaxAttempts: 1}, func(ctx context.Context, in int) (int, error) {
		atomic.AddInt32(&calls, 1)
		return 0, boom
	})
	if _, err := fn(context.Background(), 1); !errors.Is(err, boom) {
		t.Fatalf("expected boom, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected 1 call, got %d", got)
	}
}

func TestCircuitBreaker_HalfOpenLimitsConcurrentProbes(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		Name:                     "probe-limit",
		FailureThreshold:         1,
		RecoveryTimeout:          30 * time.Millisecond,
		HalfOpenSuccessThreshold: 2,
	})
	var calls int32
	down := errors.New("still down")
	fn := CircuitBreakerWrapper(cb, nil, func(ctx context.Context, in int) (int, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(50 * time.Millisecond)
		return 0, down
	})

	if _, err := fn(context.Background(), 0); !errors.Is(err, down) {
		t.Fatalf("expected the trip call to fail with down, got %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	atomic.StoreInt32(&calls, 0)

	var rejected int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := fn(context.Background(), 0); errors.Is(err, ErrCircuitBreakerOpen) {
				atomic.AddInt32(&rejected, 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	got := atomic.LoadInt32(&calls)
	if got < 1 || got > 2 {
		t.Fatalf("expected 1..2 probes to reach the target, got %d", got)
	}
	if r := atomic.LoadInt32(&rejected); r != 50-got {
		t.Fatalf("expected %d rejections, got %d", 50-got, r)
	}
}

func TestCircuitBreaker_ResultsAdmittedBeforeTripAreNotProbes(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		Name:                     "stale",
		FailureThreshold:         1,
		RecoveryTimeout:          20 * time.Millisecond,
		HalfOpenSuccessThreshold: 2,
	})
	gate := make(chan struct{})
	admitted := make(chan struct{}, 2)
	slow := CircuitBreakerWrapper(cb, nil, func(ctx context.Context, in int) (int, error) {
		admitted <- struct{}{}
		<-gate
		return in, nil
	})
	failing := CircuitBreakerWrapper(cb, nil, func(ctx context.Context, in int) (int, error) {
		return 0, errors.New("down")
	})

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = slow(context.Background(), 1)
		}()
	}
	<-admitted
	<-admitted // both admitted while Closed

	_, _ = failing(context.Background(), 1)
	if cb.State() != StateOpen {
		t.Fatalf("expected StateOpen, got %v", cb.State())
	}
	time.Sleep(30 * time.Millisecond)
	if cb.State() != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen, got %v", cb.State())
	}
	close(gate)
	wg.Wait()
	if cb.State() != StateHalfOpen {
		t.Fatalf("stale successes must not close the breaker, got %v", cb.State())
	}
}

func TestCircuitBreaker_ProbeSlotReleasedOnRecord(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          10 * time.Millisecond,
		HalfOpenSuccessThreshold: 2,
	})
	cb.RecordFailure()
	time.Sleep(20 * time.Millisecond)
	if !cb.AllowRequest() || !cb.AllowRequest() {
		t.Fatal("expected two probes to be admitted")
	}
	if cb.AllowRequest() {
		t.Fatal("expected the third concurrent probe to be rejected")
	}
	cb.RecordSuccess()
	if !cb.AllowRequest() {
		t.Fatal("expected a slot to be free after a probe reported back")
	}
	cb.RecordSuccess()
	if cb.State() != StateClosed {
		t.Fatalf("expected StateClosed after two successes, got %v", cb.State())
	}
}

func TestCircuitBreaker_AbandonedProbeSlotsAreReclaimed(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          10 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})
	cb.RecordFailure()
	time.Sleep(20 * time.Millisecond)
	if !cb.AllowRequest() { // never recorded
		t.Fatal("expected the first probe to be admitted")
	}
	if cb.AllowRequest() {
		t.Fatal("expected the second probe to be rejected")
	}
	time.Sleep(20 * time.Millisecond)
	if !cb.AllowRequest() {
		t.Fatal("expected the abandoned slot to be reclaimed after the recovery timeout")
	}
}

func TestTokenBucketLimiter_ClampsNegativeElapsed(t *testing.T) {
	l := NewTokenBucketLimiter(10, 5)
	l.lastRefill = time.Now().Add(time.Hour) // as if the clock stepped backwards
	if got := l.AvailableTokens(); got != 10 {
		t.Fatalf("expected 10 available tokens, got %v", got)
	}
	if !l.Allow(1) {
		t.Fatal("expected the call to be admitted")
	}
	if l.tokens < 0 {
		t.Fatalf("tokens must never go negative, got %v", l.tokens)
	}
}

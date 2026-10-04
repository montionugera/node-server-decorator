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

func TestCircuitBreaker_LateResultFromAbandonedProbeIsDiscarded(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          30 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})

	aEntered := make(chan struct{})
	aRelease := make(chan struct{})
	bEntered := make(chan struct{})
	bRelease := make(chan struct{})

	wrapped := CircuitBreakerWrapper(cb, nil, func(ctx context.Context, probe string) (string, error) {
		switch probe {
		case "trip":
			return "", errors.New("trip err")
		case "A":
			close(aEntered)
			<-aRelease
			return "A-ok", nil
		case "B":
			close(bEntered)
			<-bRelease
			return "B-ok", nil
		default:
			return "", errors.New("unknown")
		}
	})

	// Trip it with one failing call.
	if _, err := wrapped(context.Background(), "trip"); err == nil {
		t.Fatal("expected trip call to fail")
	}
	if cb.State() != StateOpen {
		t.Fatalf("expected StateOpen, got %v", cb.State())
	}

	// Sleep 40ms (recovery timeout is 30ms) so it transitions or allows half-open probe.
	time.Sleep(40 * time.Millisecond)

	// Start probe A in a goroutine; it blocks on a channel inside fn.
	aDone := make(chan error, 1)
	go func() {
		_, err := wrapped(context.Background(), "A")
		aDone <- err
	}()
	<-aEntered // deterministic: A is inside fn

	// Sleep 40ms so A's probe slot is held longer than the recovery timeout (30ms).
	time.Sleep(40 * time.Millisecond)

	// Start probe B in a second goroutine (it must be ADMITTED via reclaim, i.e. reach fn; it also blocks on its own channel).
	bDone := make(chan error, 1)
	go func() {
		_, err := wrapped(context.Background(), "B")
		bDone <- err
	}()
	select {
	case <-bEntered:
		// B reached fn via reclaim
	case <-time.After(100 * time.Millisecond):
		t.Fatal("probe B was not admitted via reclaim")
	}

	// Now let A return success: the breaker state must still be StateHalfOpen (A's late result is stale).
	close(aRelease)
	if err := <-aDone; err != nil {
		t.Fatalf("probe A returned error: %v", err)
	}
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected breaker to remain StateHalfOpen after stale probe A, got %v", state)
	}

	// Then let B return success: state becomes StateClosed.
	close(bRelease)
	if err := <-bDone; err != nil {
		t.Fatalf("probe B returned error: %v", err)
	}
	if state := cb.State(); state != StateClosed {
		t.Fatalf("expected breaker to transition to StateClosed after probe B, got %v", state)
	}
}

func TestCircuitBreaker_PanickingProbeReleasesItsSlot(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          200 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})

	wrapped := CircuitBreakerWrapper(cb, nil, func(ctx context.Context, mode string) (string, error) {
		switch mode {
		case "trip":
			return "", errors.New("down")
		case "panic":
			panic("something went terribly wrong")
		case "success":
			return "ok", nil
		default:
			return "", errors.New("unknown mode")
		}
	})

	// Trip with a failing call
	if _, err := wrapped(context.Background(), "trip"); err == nil {
		t.Fatal("expected trip call to fail")
	}
	if cb.State() != StateOpen {
		t.Fatalf("expected StateOpen, got %v", cb.State())
	}

	// Sleep 220ms
	time.Sleep(220 * time.Millisecond)

	// Call the wrapper in a mode where fn panics (catch the panic in the test with a deferred recover inside a helper closure and assert it did panic)
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		_, _ = wrapped(context.Background(), "panic")
	}()
	if !panicked {
		t.Fatal("expected wrapper call to panic")
	}

	// Assert state is still StateHalfOpen
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen after panic, got %v", state)
	}

	// Then IMMEDIATELY call again in a succeeding mode: it must reach fn (not return ErrCircuitBreakerOpen) and the breaker must end StateClosed.
	res, err := wrapped(context.Background(), "success")
	if err != nil {
		t.Fatalf("expected succeeding call to reach fn, got error: %v", err)
	}
	if res != "ok" {
		t.Fatalf("expected 'ok', got %q", res)
	}
	if state := cb.State(); state != StateClosed {
		t.Fatalf("expected breaker to end StateClosed, got %v", state)
	}
}

func TestCircuitBreaker_ManualEpochAPIDiscardsStaleResults(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          30 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})

	stale, ok := cb.Acquire()
	if !ok {
		t.Fatal("expected first Acquire to succeed while Closed")
	}

	e, ok := cb.Acquire()
	if !ok {
		t.Fatal("expected second Acquire to succeed while Closed")
	}
	cb.RecordFailureAt(e)
	if state := cb.State(); state != StateOpen {
		t.Fatalf("expected StateOpen after failure, got %v", state)
	}

	time.Sleep(40 * time.Millisecond)
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen after recovery timeout, got %v", state)
	}

	cb.RecordSuccessAt(stale)
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected breaker to remain StateHalfOpen after stale RecordSuccessAt, got %v", state)
	}

	cb.RecordFailureAt(stale)
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected breaker to remain StateHalfOpen after stale RecordFailureAt, got %v", state)
	}

	p, ok := cb.Acquire()
	if !ok {
		t.Fatal("expected Acquire in HalfOpen to succeed")
	}
	cb.RecordSuccessAt(p)
	if state := cb.State(); state != StateClosed {
		t.Fatalf("expected StateClosed after probe success, got %v", state)
	}
}

func TestCircuitBreaker_UnpairedManualSuccessCannotCloseHalfOpen(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          30 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})

	if !cb.AllowRequest() {
		t.Fatal("expected AllowRequest to succeed")
	}
	cb.RecordFailure()
	if state := cb.State(); state != StateOpen {
		t.Fatalf("expected StateOpen, got %v", state)
	}

	time.Sleep(40 * time.Millisecond)
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen, got %v", state)
	}

	// RecordSuccess() with no AllowRequest first -> still StateHalfOpen
	cb.RecordSuccess()
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected breaker to remain StateHalfOpen after unpaired RecordSuccess, got %v", state)
	}

	// Then AllowRequest() must be true; RecordSuccess() -> StateClosed.
	if !cb.AllowRequest() {
		t.Fatal("expected AllowRequest in HalfOpen to be true")
	}
	cb.RecordSuccess()
	if state := cb.State(); state != StateClosed {
		t.Fatalf("expected breaker to transition to StateClosed, got %v", state)
	}
}

func TestCircuitBreaker_UnpairedManualFailureReopensHalfOpen(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{
		FailureThreshold:         1,
		RecoveryTimeout:          30 * time.Millisecond,
		HalfOpenSuccessThreshold: 1,
	})

	cb.RecordFailure()
	if state := cb.State(); state != StateOpen {
		t.Fatalf("expected StateOpen, got %v", state)
	}

	time.Sleep(40 * time.Millisecond)
	if state := cb.State(); state != StateHalfOpen {
		t.Fatalf("expected StateHalfOpen, got %v", state)
	}

	// RecordFailure() with no AllowRequest first: fails safe and re-opens, unlike an unpaired RecordSuccess().
	cb.RecordFailure()
	if state := cb.State(); state != StateOpen {
		t.Fatalf("expected an unpaired RecordFailure to re-open the breaker, got %v", state)
	}
	if cb.AllowRequest() {
		t.Fatal("expected the re-opened breaker to reject requests before the recovery timeout")
	}
}

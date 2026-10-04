package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

// cbCovExpireRecovery backdates the last state change so the recovery timeout has elapsed,
// without sleeping.
func cbCovExpireRecovery(cb *CircuitBreaker) {
	cb.mu.Lock()
	cb.lastStateChange = time.Now().Add(-2 * cb.recoveryTimeout)
	cb.mu.Unlock()
}

func cbCovTrip(cb *CircuitBreaker, failures int) {
	for i := 0; i < failures; i++ {
		cb.RecordFailure()
	}
}

func TestCircuitBreakerCoverage_StateString(t *testing.T) {
	cases := map[CircuitState]string{
		StateClosed:      "closed",
		StateOpen:        "open",
		StateHalfOpen:    "half-open",
		CircuitState(3):  "unknown",
		CircuitState(-1): "unknown",
	}
	for state, want := range cases {
		if got := state.String(); got != want {
			t.Errorf("CircuitState(%d).String() = %q, want %q", int(state), got, want)
		}
	}
}

func TestCircuitBreakerCoverage_DefaultOptions(t *testing.T) {
	want := CircuitBreakerOptions{
		Name:                     "default",
		FailureThreshold:         5,
		RecoveryTimeout:          5 * time.Second,
		HalfOpenSuccessThreshold: 2,
	}
	if got := DefaultCircuitBreakerOptions(); got != want {
		t.Errorf("DefaultCircuitBreakerOptions() = %+v, want %+v", got, want)
	}
}

func TestCircuitBreakerCoverage_NonPositiveOptionsFallBackToDefaults(t *testing.T) {
	for name, opts := range map[string]CircuitBreakerOptions{
		"zero":     {},
		"negative": {FailureThreshold: -1, RecoveryTimeout: -time.Second, HalfOpenSuccessThreshold: -3},
	} {
		t.Run(name, func(t *testing.T) {
			cb := NewCircuitBreaker(opts)
			if cb.Name() != "default" {
				t.Errorf("Name() = %q, want default", cb.Name())
			}
			if cb.failureThreshold != 5 || cb.recoveryTimeout != 5*time.Second || cb.halfOpenSuccessThreshold != 2 {
				t.Errorf("thresholds = (%d, %v, %d), want (5, 5s, 2)", cb.failureThreshold, cb.recoveryTimeout, cb.halfOpenSuccessThreshold)
			}
			if cb.State() != StateClosed {
				t.Errorf("initial state = %v, want closed", cb.State())
			}

			// The defaulted failure threshold is what trips the breaker.
			cbCovTrip(cb, 4)
			if cb.State() != StateClosed {
				t.Fatalf("state after 4 failures = %v, want closed", cb.State())
			}
			cb.RecordFailure()
			if cb.State() != StateOpen {
				t.Fatalf("state after 5 failures = %v, want open", cb.State())
			}
		})
	}
}

func TestCircuitBreakerCoverage_ExplicitOptionsAreKept(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{Name: "payments", FailureThreshold: 1, RecoveryTimeout: time.Minute, HalfOpenSuccessThreshold: 1})
	if cb.Name() != "payments" {
		t.Errorf("Name() = %q, want payments", cb.Name())
	}
	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Errorf("state = %v, want open after a single failure with threshold 1", cb.State())
	}
}

func TestCircuitBreakerCoverage_SuccessResetsConsecutiveFailures(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 2, RecoveryTimeout: time.Minute})

	cb.RecordFailure()
	cb.RecordSuccess()
	cb.RecordFailure()
	if cb.State() != StateClosed {
		t.Fatalf("state = %v, want closed: the failures were not consecutive", cb.State())
	}
	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Fatalf("state = %v, want open after two consecutive failures", cb.State())
	}
}

func TestCircuitBreakerCoverage_ResetClosesAnOpenBreakerAndClearsFailures(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 2, RecoveryTimeout: time.Minute})
	cbCovTrip(cb, 2)
	if cb.AllowRequest() {
		t.Fatal("open breaker must reject requests")
	}

	cb.Reset()

	if cb.State() != StateClosed || !cb.AllowRequest() {
		t.Fatalf("after Reset: state = %v, want closed and admitting", cb.State())
	}
	cb.RecordFailure()
	if cb.State() != StateClosed {
		t.Errorf("state = %v, want closed: Reset must clear the failure count", cb.State())
	}
}

func TestCircuitBreakerCoverage_ResetInvalidatesInFlightResults(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute})
	release := make(chan struct{})
	started := make(chan struct{})
	wrapped := CircuitBreakerWrapper(cb, nil, func(context.Context, int) (int, error) {
		close(started)
		<-release
		return 0, errors.New("late failure")
	})

	done := make(chan error, 1)
	go func() {
		_, err := wrapped(context.Background(), 1)
		done <- err
	}()
	<-started
	cb.Reset() // bumps the epoch while the call is in flight
	close(release)

	if err := <-done; err == nil || err.Error() != "late failure" {
		t.Fatalf("err = %v, want the fn error", err)
	}
	if cb.State() != StateClosed {
		t.Errorf("state = %v, want closed: a result admitted before Reset is stale", cb.State())
	}
}

func TestCircuitBreakerCoverage_HalfOpenLimitsProbesAndReopensOnFailure(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute, HalfOpenSuccessThreshold: 2})
	cb.RecordFailure()
	cbCovExpireRecovery(cb)
	if cb.State() != StateHalfOpen {
		t.Fatalf("state = %v, want half-open once the recovery timeout elapsed", cb.State())
	}

	if !cb.AllowRequest() || !cb.AllowRequest() {
		t.Fatal("half-open must admit HalfOpenSuccessThreshold probes")
	}
	if cb.AllowRequest() {
		t.Fatal("half-open must reject a probe beyond the threshold")
	}

	cb.RecordFailure()
	if cb.State() != StateOpen {
		t.Fatalf("state = %v, want open after a failed probe", cb.State())
	}
	if cb.AllowRequest() {
		t.Error("re-opened breaker must reject requests")
	}
}

func TestCircuitBreakerCoverage_HalfOpenClosesAfterEnoughSuccesses(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute, HalfOpenSuccessThreshold: 2})
	cb.RecordFailure()
	cbCovExpireRecovery(cb)

	if !cb.AllowRequest() {
		t.Fatal("first probe rejected")
	}
	cb.RecordSuccess()
	if cb.State() != StateHalfOpen {
		t.Fatalf("state = %v, want half-open after 1 of 2 successes", cb.State())
	}
	if !cb.AllowRequest() {
		t.Fatal("second probe rejected")
	}
	cb.RecordSuccess()
	if cb.State() != StateClosed {
		t.Fatalf("state = %v, want closed after 2 successes", cb.State())
	}
}

func TestCircuitBreakerCoverage_AbandonedHalfOpenProbesAreReclaimed(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute, HalfOpenSuccessThreshold: 1})
	cb.RecordFailure()
	cbCovExpireRecovery(cb)

	if !cb.AllowRequest() {
		t.Fatal("first probe rejected")
	}
	if cb.AllowRequest() {
		t.Fatal("a second probe must wait while the first is in flight")
	}

	// The probe never reports back; after another recovery timeout the slot is freed.
	cbCovExpireRecovery(cb)
	if !cb.AllowRequest() {
		t.Fatal("an abandoned probe slot must be reclaimed after the recovery timeout")
	}
	if cb.AllowRequest() {
		t.Error("the reclaimed slot is taken again, a further probe must be rejected")
	}
	if cb.State() != StateHalfOpen {
		t.Errorf("state = %v, want half-open", cb.State())
	}
}

func TestCircuitBreakerCoverage_WrapperWithoutFallback(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute})
	boom := errors.New("upstream 500")
	calls := 0
	wrapped := CircuitBreakerWrapper(cb, nil, func(_ context.Context, in int) (int, error) {
		calls++
		if in < 0 {
			return 123, boom
		}
		return in * 2, nil
	})

	if got, err := wrapped(context.Background(), 21); err != nil || got != 42 {
		t.Fatalf("got (%d, %v), want (42, nil)", got, err)
	}
	if got, err := wrapped(context.Background(), -1); !errors.Is(err, boom) || got != 0 {
		t.Fatalf("got (%d, %v), want (0, upstream 500)", got, err)
	}
	if got, err := wrapped(context.Background(), 21); !errors.Is(err, ErrCircuitBreakerOpen) || got != 0 {
		t.Fatalf("got (%d, %v), want (0, ErrCircuitBreakerOpen)", got, err)
	}
	if calls != 2 {
		t.Errorf("fn calls = %d, want 2: an open breaker must not call fn", calls)
	}
}

func TestCircuitBreakerCoverage_WrapperFallbackReceivesTheCause(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute})
	boom := errors.New("upstream 500")
	var causes []error
	fallback := func(_ context.Context, in int, err error) (string, error) {
		causes = append(causes, err)
		return "fallback", nil
	}
	wrapped := CircuitBreakerWrapper(cb, fallback, func(context.Context, int) (string, error) {
		return "", boom
	})

	for i := 0; i < 2; i++ {
		if got, err := wrapped(context.Background(), i); err != nil || got != "fallback" {
			t.Fatalf("call %d: got (%q, %v), want (fallback, nil)", i, got, err)
		}
	}
	if len(causes) != 2 || !errors.Is(causes[0], boom) || !errors.Is(causes[1], ErrCircuitBreakerOpen) {
		t.Errorf("fallback causes = %v, want [upstream 500, circuit breaker is open]", causes)
	}
}

// A probe that panics after the breaker moved on (Reset, re-trip, new probe admitted) holds a
// stale epoch: its release must not free the slot that now belongs to the newer probe.
func TestCircuitBreakerCoverage_StalePanickedProbeDoesNotFreeANewerProbeSlot(t *testing.T) {
	cb := NewCircuitBreaker(CircuitBreakerOptions{FailureThreshold: 1, RecoveryTimeout: time.Minute, HalfOpenSuccessThreshold: 1})
	cb.RecordFailure()
	cbCovExpireRecovery(cb)

	wrapped := CircuitBreakerWrapper(cb, nil, func(context.Context, int) (int, error) {
		cb.Reset()
		cb.RecordFailure()
		cbCovExpireRecovery(cb)
		if !cb.AllowRequest() {
			t.Error("the newer probe must be admitted after the re-trip")
		}
		panic("stale probe blew up")
	})

	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected the wrapped call to panic")
			}
		}()
		_, _ = wrapped(context.Background(), 0)
	}()

	if cb.State() != StateHalfOpen {
		t.Fatalf("state = %v, want half-open", cb.State())
	}
	if cb.AllowRequest() {
		t.Error("the stale probe's release freed the newer probe's slot")
	}
}

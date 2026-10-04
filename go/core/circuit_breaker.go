package core

import (
	"context"
	"errors"
	"sync"
	"time"
)

// CircuitState represents the 3 states of a circuit breaker.
type CircuitState int

const (
	StateClosed CircuitState = iota
	StateOpen
	StateHalfOpen
)

func (s CircuitState) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// ErrCircuitBreakerOpen is returned when execution is rejected due to an open circuit.
var ErrCircuitBreakerOpen = errors.New("circuit breaker is open")

// CircuitBreakerOptions configures thresholds and recovery timeouts.
type CircuitBreakerOptions struct {
	Name                     string
	FailureThreshold         int
	RecoveryTimeout          time.Duration
	HalfOpenSuccessThreshold int
}

// DefaultCircuitBreakerOptions returns standard defaults.
func DefaultCircuitBreakerOptions() CircuitBreakerOptions {
	return CircuitBreakerOptions{
		Name:                     "default",
		FailureThreshold:         5,
		RecoveryTimeout:          5 * time.Second,
		HalfOpenSuccessThreshold: 2,
	}
}

// CircuitBreaker manages a state machine for preventing cascading failures.
type CircuitBreaker struct {
	mu                       sync.RWMutex
	name                     string
	failureThreshold         int
	recoveryTimeout          time.Duration
	halfOpenSuccessThreshold int

	state                CircuitState
	consecutiveFailures  int
	consecutiveSuccesses int
	lastStateChange      time.Time
	// halfOpenInFlight counts probes admitted in Half-Open whose result is not recorded yet.
	halfOpenInFlight int
	// epoch is bumped on every state transition; a result recorded with an older epoch is stale.
	epoch uint64
}

// NewCircuitBreaker constructs a new breaker with the given options.
func NewCircuitBreaker(opts CircuitBreakerOptions) *CircuitBreaker {
	if opts.FailureThreshold <= 0 {
		opts.FailureThreshold = 5
	}
	if opts.RecoveryTimeout <= 0 {
		opts.RecoveryTimeout = 5 * time.Second
	}
	if opts.HalfOpenSuccessThreshold <= 0 {
		opts.HalfOpenSuccessThreshold = 2
	}
	if opts.Name == "" {
		opts.Name = "default"
	}

	return &CircuitBreaker{
		name:                     opts.Name,
		failureThreshold:         opts.FailureThreshold,
		recoveryTimeout:          opts.RecoveryTimeout,
		halfOpenSuccessThreshold: opts.HalfOpenSuccessThreshold,
		state:                    StateClosed,
		lastStateChange:          time.Now(),
	}
}

// Name returns the identifier of this circuit breaker.
func (cb *CircuitBreaker) Name() string {
	return cb.name
}

// transitionLocked moves to a new state; the caller holds cb.mu.
func (cb *CircuitBreaker) transitionLocked(to CircuitState) {
	cb.state = to
	cb.epoch++
	cb.halfOpenInFlight = 0
	cb.consecutiveSuccesses = 0
	cb.lastStateChange = time.Now()
}

// refreshLocked evaluates automatic recovery from Open to Half-Open; the caller holds cb.mu.
func (cb *CircuitBreaker) refreshLocked() CircuitState {
	if cb.state == StateOpen && time.Since(cb.lastStateChange) >= cb.recoveryTimeout {
		cb.transitionLocked(StateHalfOpen)
		cb.consecutiveFailures = 0
	}
	return cb.state
}

// State returns the current state, evaluating automatic recovery from Open to Half-Open.
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.refreshLocked()
}

// acquire admits a call and returns its admission epoch. In Half-Open at most
// halfOpenSuccessThreshold probes are in flight at once.
func (cb *CircuitBreaker) acquire() (uint64, bool) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.refreshLocked() {
	case StateOpen:
		return 0, false
	case StateHalfOpen:
		if cb.halfOpenInFlight >= cb.halfOpenSuccessThreshold {
			if time.Since(cb.lastStateChange) < cb.recoveryTimeout {
				return 0, false
			}
			// Probes that never reported back are treated as abandoned; the epoch bump makes any late result from them stale.
			cb.epoch++
			cb.halfOpenInFlight = 0
			cb.lastStateChange = time.Now()
		}
		cb.halfOpenInFlight++
	}
	return cb.epoch, true
}

// release gives back a Half-Open probe slot without recording a result (the call panicked).
func (cb *CircuitBreaker) release(epoch uint64) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if epoch != cb.epoch {
		return
	}
	if cb.state == StateHalfOpen && cb.halfOpenInFlight > 0 {
		cb.halfOpenInFlight--
	}
}

// record applies a call result. When checkEpoch is set, a result admitted under an
// earlier state (a stale result) is ignored.
func (cb *CircuitBreaker) record(epoch uint64, checkEpoch bool, success bool) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if checkEpoch && epoch != cb.epoch {
		return
	}
	switch {
	case cb.state == StateHalfOpen && success:
		if !checkEpoch && cb.halfOpenInFlight == 0 {
			return
		}
		if cb.halfOpenInFlight > 0 {
			cb.halfOpenInFlight--
		}
		cb.consecutiveSuccesses++
		if cb.consecutiveSuccesses >= cb.halfOpenSuccessThreshold {
			cb.transitionLocked(StateClosed)
			cb.consecutiveFailures = 0
		}
	case cb.state == StateHalfOpen:
		cb.transitionLocked(StateOpen)
		cb.consecutiveFailures++
	case cb.state == StateClosed && success:
		cb.consecutiveFailures = 0
	case cb.state == StateClosed:
		cb.consecutiveFailures++
		if cb.consecutiveFailures >= cb.failureThreshold {
			cb.transitionLocked(StateOpen)
		}
	}
}

// AllowRequest checks whether a call may proceed. In Half-Open it takes a probe slot,
// released by the next RecordSuccess/RecordFailure.
func (cb *CircuitBreaker) AllowRequest() bool {
	_, ok := cb.acquire()
	return ok
}

// Acquire admits a call like AllowRequest and also returns the admission epoch. Pass it to
// RecordSuccessAt / RecordFailureAt so a result admitted before a state transition is ignored.
func (cb *CircuitBreaker) Acquire() (epoch uint64, ok bool) {
	return cb.acquire()
}

// RecordSuccess records a successful execution. In Half-Open, a call with no
// admitted probe in flight (no preceding AllowRequest) is ignored, so an
// unpaired success cannot close the circuit.
func (cb *CircuitBreaker) RecordSuccess() {
	cb.record(0, false, true)
}

// RecordSuccessAt records a success for a call admitted by Acquire; a stale epoch is ignored.
func (cb *CircuitBreaker) RecordSuccessAt(epoch uint64) {
	cb.record(epoch, true, true)
}

// RecordFailure records an error and may trip the circuit to Open. In Half-Open
// it re-opens the circuit even when no probe is in flight; this is deliberately
// asymmetric with RecordSuccess (failing safe) and matches the Node and Python breakers.
func (cb *CircuitBreaker) RecordFailure() {
	cb.record(0, false, false)
}

// RecordFailureAt records a failure for a call admitted by Acquire; a stale epoch is ignored.
func (cb *CircuitBreaker) RecordFailureAt(epoch uint64) {
	cb.record(epoch, true, false)
}

// Reset explicitly forces the circuit breaker back into Closed state.
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.transitionLocked(StateClosed)
	cb.consecutiveFailures = 0
}

// CircuitBreakerWrapper wraps a function with circuit breaker protection and optional fallback.
func CircuitBreakerWrapper[In, Out any](
	cb *CircuitBreaker,
	fallback func(ctx context.Context, in In, err error) (Out, error),
	fn func(context.Context, In) (Out, error),
) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		var zero Out
		epoch, ok := cb.acquire()
		if !ok {
			if fallback != nil {
				return fallback(ctx, in, ErrCircuitBreakerOpen)
			}
			return zero, ErrCircuitBreakerOpen
		}

		recorded := false
		defer func() {
			if !recorded {
				cb.release(epoch)
			}
		}()

		res, err := fn(ctx, in)
		if err != nil {
			recorded = true
			cb.record(epoch, true, false)
			if fallback != nil {
				return fallback(ctx, in, err)
			}
			return zero, err
		}

		recorded = true
		cb.record(epoch, true, true)
		return res, nil
	}
}

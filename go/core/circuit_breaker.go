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

	state                    CircuitState
	consecutiveFailures      int
	consecutiveSuccesses     int
	lastStateChange          time.Time
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

// State returns the current state, evaluating automatic recovery from Open to Half-Open.
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == StateOpen && time.Since(cb.lastStateChange) >= cb.recoveryTimeout {
		cb.state = StateHalfOpen
		cb.consecutiveFailures = 0
		cb.consecutiveSuccesses = 0
		cb.lastStateChange = time.Now()
	}
	return cb.state
}

// AllowRequest checks whether a call may proceed.
func (cb *CircuitBreaker) AllowRequest() bool {
	state := cb.State()
	return state == StateClosed || state == StateHalfOpen
}

// RecordSuccess records a successful execution.
func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == StateHalfOpen {
		cb.consecutiveSuccesses++
		if cb.consecutiveSuccesses >= cb.halfOpenSuccessThreshold {
			cb.state = StateClosed
			cb.consecutiveFailures = 0
			cb.consecutiveSuccesses = 0
			cb.lastStateChange = time.Now()
		}
	} else if cb.state == StateClosed {
		cb.consecutiveFailures = 0
	}
}

// RecordFailure records an error and may trip the circuit to Open.
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == StateHalfOpen {
		cb.state = StateOpen
		cb.consecutiveFailures++
		cb.consecutiveSuccesses = 0
		cb.lastStateChange = time.Now()
	} else if cb.state == StateClosed {
		cb.consecutiveFailures++
		if cb.consecutiveFailures >= cb.failureThreshold {
			cb.state = StateOpen
			cb.lastStateChange = time.Now()
		}
	}
}

// Reset explicitly forces the circuit breaker back into Closed state.
func (cb *CircuitBreaker) Reset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.state = StateClosed
	cb.consecutiveFailures = 0
	cb.consecutiveSuccesses = 0
	cb.lastStateChange = time.Now()
}

// CircuitBreakerWrapper wraps a function with circuit breaker protection and optional fallback.
func CircuitBreakerWrapper[In, Out any](
	cb *CircuitBreaker,
	fallback func(ctx context.Context, in In, err error) (Out, error),
	fn func(context.Context, In) (Out, error),
) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		var zero Out
		if !cb.AllowRequest() {
			if fallback != nil {
				return fallback(ctx, in, ErrCircuitBreakerOpen)
			}
			return zero, ErrCircuitBreakerOpen
		}

		res, err := fn(ctx, in)
		if err != nil {
			cb.RecordFailure()
			if fallback != nil {
				return fallback(ctx, in, err)
			}
			return zero, err
		}

		cb.RecordSuccess()
		return res, nil
	}
}

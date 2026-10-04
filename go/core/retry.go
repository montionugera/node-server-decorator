package core

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"time"
)

// RetryOptions configures exponential backoff with jitter and retry predicates.
type RetryOptions struct {
	MaxAttempts     int
	InitialInterval time.Duration
	MaxInterval     time.Duration
	Multiplier      float64
	Jitter          bool
	RetryIf         func(err error) bool
}

// DefaultRetryOptions returns standard production defaults.
func DefaultRetryOptions() RetryOptions {
	return RetryOptions{
		MaxAttempts:     3,
		InitialInterval: 50 * time.Millisecond,
		MaxInterval:     2 * time.Second,
		Multiplier:      2.0,
		Jitter:          true,
		RetryIf:         nil,
	}
}

func calculateBackoff(opts RetryOptions, attempt int) time.Duration {
	if attempt <= 0 {
		return 0
	}
	mult := math.Pow(opts.Multiplier, float64(attempt-1))
	interval := float64(opts.InitialInterval) * mult
	if interval > float64(opts.MaxInterval) {
		interval = float64(opts.MaxInterval)
	}
	if opts.Jitter && interval > 0 {
		interval = float64(rand.Int63n(int64(interval) + 1))
	}
	return time.Duration(interval)
}

// Retry wraps a function with exponential backoff and jitter retry semantics.
//
// MaxAttempts 0 (the zero value) means the default of 3. A negative MaxAttempts is a
// configuration error and panics at wrap time (contracts/rules/resilience.md).
func Retry[In, Out any](
	opts RetryOptions,
	fn func(context.Context, In) (Out, error),
) func(context.Context, In) (Out, error) {
	if opts.MaxAttempts < 0 {
		panic(fmt.Sprintf("core.Retry: MaxAttempts must be an integer >= 1, got %d", opts.MaxAttempts))
	}
	if opts.MaxAttempts == 0 {
		opts.MaxAttempts = 3
	}
	if opts.Multiplier <= 0 {
		opts.Multiplier = 2.0
	}
	if opts.InitialInterval <= 0 {
		opts.InitialInterval = 50 * time.Millisecond
	}
	if opts.MaxInterval <= 0 {
		opts.MaxInterval = 2 * time.Second
	}

	return func(ctx context.Context, in In) (Out, error) {
		var zero Out
		for attempt := 1; ; attempt++ {
			select {
			case <-ctx.Done():
				return zero, ctx.Err()
			default:
			}

			res, err := fn(ctx, in)
			if err == nil {
				return res, nil
			}

			if attempt >= opts.MaxAttempts {
				return zero, err
			}

			if opts.RetryIf != nil && !opts.RetryIf(err) {
				return zero, err
			}

			delay := calculateBackoff(opts, attempt)
			if delay > 0 {
				select {
				case <-ctx.Done():
					return zero, ctx.Err()
				case <-time.After(delay):
				}
			}
		}
	}
}

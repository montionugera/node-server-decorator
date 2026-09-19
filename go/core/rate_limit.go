package core

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrRateLimitExceeded is returned when an invocation exceeds the allowed token bucket capacity.
var ErrRateLimitExceeded = errors.New("rate limit exceeded")

// TokenBucketLimiter implements a thread-safe token bucket rate limiter.
type TokenBucketLimiter struct {
	mu         sync.Mutex
	capacity   float64
	refillRate float64 // tokens per second
	tokens     float64
	lastRefill time.Time
}

// NewTokenBucketLimiter creates a new limiter with the specified burst capacity and refill rate.
func NewTokenBucketLimiter(capacity float64, refillRate float64) *TokenBucketLimiter {
	if capacity <= 0 {
		capacity = 10
	}
	if refillRate <= 0 {
		refillRate = 5.0
	}
	return &TokenBucketLimiter{
		capacity:   capacity,
		refillRate: refillRate,
		tokens:     capacity,
		lastRefill: time.Now(),
	}
}

// Allow consumes the specified number of tokens if available, returning true.
// If insufficient tokens are present, it returns false without consuming tokens.
func (l *TokenBucketLimiter) Allow(cost float64) bool {
	if cost <= 0 {
		cost = 1.0
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(l.lastRefill).Seconds()
	l.lastRefill = now

	l.tokens = l.tokens + elapsed*l.refillRate
	if l.tokens > l.capacity {
		l.tokens = l.capacity
	}

	if l.tokens >= cost {
		l.tokens -= cost
		return true
	}
	return false
}

// AvailableTokens returns the current estimated number of tokens available.
func (l *TokenBucketLimiter) AvailableTokens() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(l.lastRefill).Seconds()
	tokens := l.tokens + elapsed*l.refillRate
	if tokens > l.capacity {
		tokens = l.capacity
	}
	return tokens
}

// RateLimit wraps a function with token bucket rate limiting.
func RateLimit[In, Out any](
	limiter *TokenBucketLimiter,
	fn func(context.Context, In) (Out, error),
) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		var zero Out
		if !limiter.Allow(1.0) {
			return zero, ErrRateLimitExceeded
		}
		return fn(ctx, in)
	}
}

package core

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

// rateLimitCovSlowRefill is small enough that no measurable refill happens during a test.
const rateLimitCovSlowRefill = 1e-9

func TestTokenBucketLimiter_NonPositiveOptionsFallBackToDefaults(t *testing.T) {
	for _, tc := range []struct {
		name               string
		capacity, refill   float64
		wantCap, wantRefil float64
	}{
		{"zero", 0, 0, 10, 5},
		{"negative", -3, -1, 10, 5},
		{"only capacity invalid", 0, 2, 10, 2},
		{"only refill invalid", 4, 0, 4, 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := NewTokenBucketLimiter(tc.capacity, tc.refill)
			if l.capacity != tc.wantCap || l.refillRate != tc.wantRefil {
				t.Fatalf("got capacity=%v refill=%v, want %v/%v", l.capacity, l.refillRate, tc.wantCap, tc.wantRefil)
			}
			if got := l.AvailableTokens(); got != tc.wantCap {
				t.Fatalf("a new limiter must start full: got %v, want %v", got, tc.wantCap)
			}
		})
	}
}

func TestTokenBucketLimiter_NonPositiveCostCountsAsOne(t *testing.T) {
	l := NewTokenBucketLimiter(2, rateLimitCovSlowRefill)
	if !l.Allow(0) {
		t.Fatal("cost 0 must be treated as 1 and allowed")
	}
	if !l.Allow(-5) {
		t.Fatal("negative cost must be treated as 1 and allowed")
	}
	if l.Allow(0) {
		t.Fatal("bucket of 2 must be empty after two cost<=0 calls")
	}
}

func TestTokenBucketLimiter_DeniedCallDoesNotConsume(t *testing.T) {
	l := NewTokenBucketLimiter(5, rateLimitCovSlowRefill)
	if l.Allow(6) {
		t.Fatal("cost above capacity must be denied")
	}
	if got := l.AvailableTokens(); math.Abs(got-5) > 1e-3 {
		t.Fatalf("denied call consumed tokens: %v left, want 5", got)
	}
	if !l.Allow(5) {
		t.Fatal("exact-capacity cost must be allowed after a denied call")
	}
	if l.Allow(1) {
		t.Fatal("bucket must be empty after spending the full capacity")
	}
}

func TestTokenBucketLimiter_RefillIsProportionalAndCapped(t *testing.T) {
	l := NewTokenBucketLimiter(10, 4)
	if !l.Allow(10) {
		t.Fatal("full bucket must allow its capacity")
	}

	// One second at 4 tokens/s.
	l.lastRefill = time.Now().Add(-time.Second)
	got := l.AvailableTokens()
	if got < 4 || got > 4.5 {
		t.Fatalf("after 1s at 4/s: %v tokens, want about 4", got)
	}
	// AvailableTokens is a read: it must not move the stored balance.
	if l.tokens != 0 {
		t.Fatalf("AvailableTokens mutated the balance to %v", l.tokens)
	}
	if l.Allow(5) {
		t.Fatal("5 tokens must not be available after refilling only about 4")
	}
	if !l.Allow(4) {
		t.Fatal("4 refilled tokens must be spendable")
	}

	// A long idle period never exceeds capacity.
	l.lastRefill = time.Now().Add(-time.Hour)
	if got := l.AvailableTokens(); got != 10 {
		t.Fatalf("refill must cap at capacity: got %v", got)
	}
	if l.Allow(10.5) {
		t.Fatal("refill must not allow more than capacity")
	}
}

func TestTokenBucketLimiter_ClockGoingBackwardsNeverRemovesTokens(t *testing.T) {
	l := NewTokenBucketLimiter(10, 100)
	if !l.Allow(7) {
		t.Fatal("setup spend failed")
	}
	l.lastRefill = time.Now().Add(time.Hour) // last refill is "in the future"
	if got := l.AvailableTokens(); got != 3 {
		t.Fatalf("negative elapsed time must be clamped to 0: got %v, want 3", got)
	}
	if !l.Allow(3) {
		t.Fatal("the 3 remaining tokens must still be spendable")
	}
	if l.tokens != 0 {
		t.Fatalf("balance after spending the remainder = %v, want 0", l.tokens)
	}
}

func TestRateLimit_DeniedReturnsZeroValueWithoutCallingFn(t *testing.T) {
	l := NewTokenBucketLimiter(1, rateLimitCovSlowRefill)
	calls := 0
	wrapped := RateLimit(l, func(_ context.Context, in int) (string, error) {
		calls++
		return "v", nil
	})

	if out, err := wrapped(context.Background(), 1); err != nil || out != "v" {
		t.Fatalf("first call = (%q, %v), want (v, nil)", out, err)
	}
	out, err := wrapped(context.Background(), 2)
	if !errors.Is(err, ErrRateLimitExceeded) {
		t.Fatalf("second call error = %v, want ErrRateLimitExceeded", err)
	}
	if out != "" {
		t.Fatalf("denied call must return the zero value, got %q", out)
	}
	if calls != 1 {
		t.Fatalf("fn ran %d times, want 1 (denied calls must not reach fn)", calls)
	}
}

func TestRateLimit_PropagatesFnErrorAndStillConsumesAToken(t *testing.T) {
	l := NewTokenBucketLimiter(1, rateLimitCovSlowRefill)
	boom := errors.New("boom")
	wrapped := RateLimit(l, func(context.Context, int) (int, error) { return 42, boom })

	out, err := wrapped(context.Background(), 0)
	if !errors.Is(err, boom) || out != 42 {
		t.Fatalf("got (%d, %v), want fn's own result (42, boom)", out, err)
	}
	if _, err := wrapped(context.Background(), 0); !errors.Is(err, ErrRateLimitExceeded) {
		t.Fatalf("a failed call still spends its token: got %v", err)
	}
}

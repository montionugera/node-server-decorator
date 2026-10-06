package core

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCalculateBackoff_NoJitter(t *testing.T) {
	opts := RetryOptions{InitialInterval: 10 * time.Millisecond, MaxInterval: 35 * time.Millisecond, Multiplier: 2}
	for _, tc := range []struct {
		attempt int
		want    time.Duration
	}{
		{-1, 0},
		{0, 0},
		{1, 10 * time.Millisecond},
		{2, 20 * time.Millisecond},
		{3, 35 * time.Millisecond},  // 40ms capped
		{60, 35 * time.Millisecond}, // huge exponent stays capped, no overflow
	} {
		if got := calculateBackoff(opts, tc.attempt); got != tc.want {
			t.Errorf("attempt %d: backoff = %v, want %v", tc.attempt, got, tc.want)
		}
	}
}

func TestCalculateBackoff_JitterStaysWithinInterval(t *testing.T) {
	opts := RetryOptions{InitialInterval: 4 * time.Millisecond, MaxInterval: time.Second, Multiplier: 3, Jitter: true}
	const ceiling = 12 * time.Millisecond // attempt 2: 4ms * 3
	distinct := map[time.Duration]struct{}{}
	for i := 0; i < 200; i++ {
		got := calculateBackoff(opts, 2)
		if got < 0 || got > ceiling {
			t.Fatalf("jittered backoff %v outside [0, %v]", got, ceiling)
		}
		distinct[got] = struct{}{}
	}
	if len(distinct) < 2 {
		t.Fatal("jitter produced a constant delay over 200 draws")
	}
}

func TestCalculateBackoff_JitterWithZeroIntervalIsZero(t *testing.T) {
	opts := RetryOptions{InitialInterval: 0, MaxInterval: time.Second, Multiplier: 2, Jitter: true}
	if got := calculateBackoff(opts, 3); got != 0 {
		t.Fatalf("zero interval with jitter = %v, want 0", got)
	}
}

func TestDefaultRetryOptions(t *testing.T) {
	d := DefaultRetryOptions()
	if d.MaxAttempts != 3 || d.InitialInterval != 50*time.Millisecond || d.MaxInterval != 2*time.Second ||
		d.Multiplier != 2.0 || !d.Jitter || d.RetryIf != nil {
		t.Fatalf("unexpected defaults: %+v", d)
	}
}

func TestRetryCoverage_NegativeMaxAttemptsPanicMessageNamesTheValue(t *testing.T) {
	defer func() {
		r := recover()
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("expected a string panic, got %v", r)
		}
		if !strings.Contains(msg, "MaxAttempts must be an integer >= 1") || !strings.Contains(msg, "-2") {
			t.Fatalf("panic message = %q", msg)
		}
	}()
	Retry(RetryOptions{MaxAttempts: -2}, func(context.Context, int) (int, error) { return 0, nil })
	t.Fatal("Retry must panic before returning a wrapper")
}

func TestRetry_ZeroOptionsUseDefaults(t *testing.T) {
	boom := errors.New("boom")
	calls := 0
	// Zero value: 3 attempts, 50ms initial, x2 multiplier, no jitter => 50ms + 100ms of backoff.
	wrapped := Retry(RetryOptions{}, func(context.Context, int) (int, error) {
		calls++
		return 0, boom
	})

	start := time.Now()
	_, err := wrapped(context.Background(), 0)
	elapsed := time.Since(start)

	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if calls != 3 {
		t.Fatalf("zero MaxAttempts ran %d attempts, want the default 3", calls)
	}
	if elapsed < 150*time.Millisecond {
		t.Fatalf("default backoff took %v, want at least 150ms (50ms + 100ms)", elapsed)
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("default backoff took %v, far above the expected 150ms", elapsed)
	}
}

func TestRetry_NonPositiveIntervalsAndMultiplierAreReplaced(t *testing.T) {
	calls := 0
	wrapped := Retry(RetryOptions{MaxAttempts: 2, InitialInterval: -1, MaxInterval: -1, Multiplier: -4},
		func(context.Context, int) (int, error) {
			calls++
			if calls == 1 {
				return 0, errors.New("first")
			}
			return 9, nil
		})
	start := time.Now()
	out, err := wrapped(context.Background(), 0)
	if err != nil || out != 9 || calls != 2 {
		t.Fatalf("got (%d, %v) after %d calls, want (9, nil) after 2", out, err, calls)
	}
	// A negative interval must not become a busy loop: the 50ms default applies.
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Fatalf("retry waited only %v, want the 50ms default interval", elapsed)
	}
}

func TestRetry_SingleAttemptNeverRetriesAndReturnsZeroValue(t *testing.T) {
	boom := errors.New("boom")
	calls := 0
	retryIfCalls := 0
	wrapped := Retry(RetryOptions{
		MaxAttempts: 1,
		RetryIf:     func(error) bool { retryIfCalls++; return true },
	}, func(context.Context, string) (int, error) {
		calls++
		return 77, boom // non-zero value alongside the error must be discarded
	})

	out, err := wrapped(context.Background(), "in")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if out != 0 {
		t.Fatalf("failed call returned %d, want the zero value", out)
	}
	if calls != 1 || retryIfCalls != 0 {
		t.Fatalf("calls=%d retryIfCalls=%d, want 1 and 0", calls, retryIfCalls)
	}
}

func TestRetry_AlreadyCancelledContextNeverCallsFn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	wrapped := Retry(RetryOptions{MaxAttempts: 5}, func(context.Context, int) (string, error) {
		calls++
		return "x", nil
	})
	out, err := wrapped(ctx, 1)
	if !errors.Is(err, context.Canceled) || out != "" {
		t.Fatalf("got (%q, %v), want (\"\", context.Canceled)", out, err)
	}
	if calls != 0 {
		t.Fatalf("fn ran %d times on a cancelled context", calls)
	}
}

func TestRetry_CancelDuringBackoffReturnsPromptly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	wrapped := Retry(RetryOptions{
		MaxAttempts:     5,
		InitialInterval: 30 * time.Second,
		MaxInterval:     30 * time.Second,
	}, func(context.Context, int) (int, error) {
		calls++
		time.AfterFunc(20*time.Millisecond, cancel)
		return 0, errors.New("transient")
	})

	start := time.Now()
	_, err := wrapped(ctx, 0)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled (not the transient error)", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("cancel was not honoured during backoff: took %v", elapsed)
	}
	if calls != 1 {
		t.Fatalf("fn ran %d times, want 1", calls)
	}
}

func TestRetry_DeadlineDuringBackoffReturnsDeadlineExceeded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	wrapped := Retry(RetryOptions{MaxAttempts: 3, InitialInterval: 30 * time.Second, MaxInterval: 30 * time.Second},
		func(context.Context, int) (int, error) { return 0, errors.New("transient") })
	if _, err := wrapped(ctx, 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}

func TestRetry_MaxIntervalCapsBackoff(t *testing.T) {
	calls := 0
	wrapped := Retry(RetryOptions{
		MaxAttempts:     4,
		InitialInterval: time.Hour, // would block for hours without the cap
		MaxInterval:     time.Millisecond,
		Multiplier:      10,
	}, func(context.Context, int) (int, error) {
		calls++
		if calls < 4 {
			return 0, errors.New("transient")
		}
		return calls, nil
	})

	start := time.Now()
	out, err := wrapped(context.Background(), 0)
	if err != nil || out != 4 {
		t.Fatalf("got (%d, %v), want (4, nil)", out, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("MaxInterval did not cap the backoff: took %v", elapsed)
	}
}

func TestRetry_RetryIfReceivesTheErrorAndStopsOnFalse(t *testing.T) {
	permanent := errors.New("permanent")
	transient := errors.New("transient")
	var seen []error
	calls := 0
	wrapped := Retry(RetryOptions{
		MaxAttempts:     5,
		InitialInterval: time.Millisecond,
		MaxInterval:     time.Millisecond,
		RetryIf: func(err error) bool {
			seen = append(seen, err)
			return errors.Is(err, transient)
		},
	}, func(context.Context, int) (int, error) {
		calls++
		if calls == 1 {
			return 0, transient
		}
		return 0, permanent
	})

	_, err := wrapped(context.Background(), 0)
	if !errors.Is(err, permanent) {
		t.Fatalf("err = %v, want permanent", err)
	}
	if calls != 2 {
		t.Fatalf("fn ran %d times, want 2 (stop on the first non-retryable error)", calls)
	}
	if len(seen) != 2 || !errors.Is(seen[0], transient) || !errors.Is(seen[1], permanent) {
		t.Fatalf("RetryIf saw %v, want [transient permanent]", seen)
	}
}

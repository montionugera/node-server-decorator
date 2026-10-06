package distlock

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"testing"
	"time"
)

// covClient is a scriptable RedisClient. Unset hooks behave like an uncontended Redis: SetNX
// succeeds and every script reports 1 (key still owned).
type covClient struct {
	mu      sync.Mutex
	setNX   func(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	eval    func(ctx context.Context, script string, keys []string, args []any) (any, error)
	setCall []covSetCall
	renews  [][]any
}

type covSetCall struct {
	key, value string
	ttl        time.Duration
}

func (c *covClient) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	c.mu.Lock()
	c.setCall = append(c.setCall, covSetCall{key, value, ttl})
	hook := c.setNX
	c.mu.Unlock()
	if hook != nil {
		return hook(ctx, key, value, ttl)
	}
	return true, nil
}

func (c *covClient) Eval(ctx context.Context, script string, keys []string, args ...any) (any, error) {
	c.mu.Lock()
	if script == RenewLockLua {
		c.renews = append(c.renews, args)
	}
	hook := c.eval
	c.mu.Unlock()
	if hook != nil {
		return hook(ctx, script, keys, args)
	}
	return int64(1), nil
}

func (c *covClient) setCalls() []covSetCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]covSetCall(nil), c.setCall...)
}

func (c *covClient) renewCalls() [][]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]any(nil), c.renews...)
}

func covContended(context.Context, string, string, time.Duration) (bool, error) { return false, nil }

func covIsLost(l Lock) bool {
	select {
	case <-l.Lost():
		return true
	default:
		return false
	}
}

func TestDistlockCoverage_NewAppliesDefaultsForNonPositiveConfig(t *testing.T) {
	for name, cfg := range map[string]Config{
		"zero":     {},
		"negative": {DefaultTTL: -time.Second, RetryInterval: -time.Millisecond},
	} {
		t.Run(name, func(t *testing.T) {
			client := &covClient{}
			cfg.Client = client
			cfg.DisableAutoRenew = true
			lock, err := New(cfg).Acquire(context.Background(), "k")
			if err != nil {
				t.Fatal(err)
			}
			if got := client.setCalls()[0].ttl; got != 10*time.Second {
				t.Errorf("SetNX ttl = %v, want the 10s default", got)
			}
			if got := lock.(*lockImpl).locker.cfg.RetryInterval; got != 100*time.Millisecond {
				t.Errorf("RetryInterval = %v, want the 100ms default", got)
			}
		})
	}
}

func TestDistlockCoverage_ExplicitConfigIsKept(t *testing.T) {
	l := New(Config{DefaultTTL: 3 * time.Second, RetryInterval: 7 * time.Millisecond})
	if l.cfg.DefaultTTL != 3*time.Second || l.cfg.RetryInterval != 7*time.Millisecond {
		t.Errorf("cfg = %+v, want ttl 3s and retry 7ms", l.cfg)
	}
}

func TestDistlockCoverage_KeyTokenAndWithTTL(t *testing.T) {
	client := &covClient{}
	locker := New(Config{Client: client, DefaultTTL: time.Minute, DisableAutoRenew: true})

	a, err := locker.Acquire(context.Background(), "orders:1", WithTTL(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	b, err := locker.Acquire(context.Background(), "orders:2")
	if err != nil {
		t.Fatal(err)
	}

	if a.Key() != "orders:1" || b.Key() != "orders:2" {
		t.Errorf("keys = %q, %q", a.Key(), b.Key())
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(a.Token()) {
		t.Errorf("token %q is not 32 lowercase hex chars", a.Token())
	}
	if a.Token() == b.Token() {
		t.Errorf("two acquisitions share the token %q", a.Token())
	}

	calls := client.setCalls()
	if calls[0] != (covSetCall{"orders:1", a.Token(), 3 * time.Second}) {
		t.Errorf("first SetNX = %+v, want key orders:1, the lock token and the WithTTL override", calls[0])
	}
	if calls[1] != (covSetCall{"orders:2", b.Token(), time.Minute}) {
		t.Errorf("second SetNX = %+v, want the default ttl", calls[1])
	}
	if covIsLost(a) {
		t.Error("a fresh lock must not be lost")
	}
}

func TestDistlockCoverage_NilClientIsRejected(t *testing.T) {
	locker := New(Config{})

	lock, err := locker.Acquire(context.Background(), "k")
	if lock != nil || err == nil || err.Error() != "distlock: RedisClient must not be nil" {
		t.Fatalf("Acquire = (%v, %v), want a nil-client error", lock, err)
	}

	ran := false
	err = locker.Do(context.Background(), "k", func(context.Context) error { ran = true; return nil })
	if err == nil || ran {
		t.Fatalf("Do: err = %v, fn ran = %v; want an error and fn not run", err, ran)
	}
}

func TestDistlockCoverage_CancelledContextNeverTouchesRedis(t *testing.T) {
	client := &covClient{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	lock, err := New(Config{Client: client}).Acquire(ctx, "k")
	if lock != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("Acquire = (%v, %v), want context.Canceled", lock, err)
	}
	if n := len(client.setCalls()); n != 0 {
		t.Errorf("SetNX calls = %d, want 0", n)
	}
}

func TestDistlockCoverage_SetNXErrorIsWrappedAndNotRetried(t *testing.T) {
	boom := errors.New("connection reset")
	client := &covClient{setNX: func(context.Context, string, string, time.Duration) (bool, error) {
		return false, boom
	}}

	lock, err := New(Config{Client: client}).Acquire(context.Background(), "k", WithWaitTimeout(time.Second))
	if lock != nil || !errors.Is(err, boom) {
		t.Fatalf("Acquire = (%v, %v), want the wrapped SetNX error", lock, err)
	}
	if errors.Is(err, ErrLockNotAcquired) {
		t.Error("a transport error must not be reported as contention")
	}
	if n := len(client.setCalls()); n != 1 {
		t.Errorf("SetNX calls = %d, want 1 (no retry on a transport error)", n)
	}
}

func TestDistlockCoverage_ZeroWaitTimeoutFailsFast(t *testing.T) {
	client := &covClient{setNX: covContended}
	ran := false

	err := New(Config{Client: client}).Do(context.Background(), "k", func(context.Context) error { ran = true; return nil })
	if !errors.Is(err, ErrLockNotAcquired) || ran {
		t.Fatalf("Do: err = %v, fn ran = %v; want ErrLockNotAcquired and fn not run", err, ran)
	}
	if n := len(client.setCalls()); n != 1 {
		t.Errorf("SetNX calls = %d, want exactly 1 with no wait timeout", n)
	}
}

func TestDistlockCoverage_TinyRetryIntervalIsFlooredAt5ms(t *testing.T) {
	client := &covClient{setNX: covContended}
	start := time.Now()

	_, err := New(Config{Client: client}).Acquire(context.Background(), "k",
		WithRetryInterval(time.Microsecond), WithWaitTimeout(40*time.Millisecond))
	elapsed := time.Since(start)

	if !errors.Is(err, ErrLockNotAcquired) {
		t.Fatalf("err = %v, want ErrLockNotAcquired", err)
	}
	if elapsed < 40*time.Millisecond {
		t.Errorf("gave up after %v, before the 40ms wait timeout", elapsed)
	}
	// With the 5ms floor at most 1 + 40/5 attempts fit; a 1µs interval would spin thousands.
	if n := len(client.setCalls()); n < 2 || n > 9 {
		t.Errorf("SetNX calls = %d, want between 2 and 9", n)
	}
}

func TestDistlockCoverage_RetrySleepIsCappedByRemainingWait(t *testing.T) {
	client := &covClient{setNX: covContended}
	start := time.Now()

	_, err := New(Config{Client: client}).Acquire(context.Background(), "k",
		WithRetryInterval(10*time.Second), WithWaitTimeout(30*time.Millisecond))
	elapsed := time.Since(start)

	if !errors.Is(err, ErrLockNotAcquired) {
		t.Fatalf("err = %v, want ErrLockNotAcquired", err)
	}
	if elapsed < 30*time.Millisecond || elapsed > 2*time.Second {
		t.Errorf("elapsed = %v, want about the 30ms wait timeout (not the 10s retry interval)", elapsed)
	}
	if n := len(client.setCalls()); n != 2 {
		t.Errorf("SetNX calls = %d, want 2 (initial attempt plus one at the deadline)", n)
	}
}

func TestDistlockCoverage_ContextCancelledWhileWaiting(t *testing.T) {
	client := &covClient{setNX: covContended}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()

	lock, err := New(Config{Client: client}).Acquire(ctx, "k",
		WithRetryInterval(10*time.Second), WithWaitTimeout(time.Minute))

	if lock != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Acquire = (%v, %v), want context.DeadlineExceeded", lock, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("returned after %v, want promptly on cancellation", elapsed)
	}
}

func TestDistlockCoverage_AcquiresOnceContentionClears(t *testing.T) {
	attempts := 0
	client := &covClient{}
	client.setNX = func(context.Context, string, string, time.Duration) (bool, error) {
		attempts++
		return attempts == 3, nil
	}

	lock, err := New(Config{Client: client, DisableAutoRenew: true}).Acquire(context.Background(), "k",
		WithRetryInterval(5*time.Millisecond), WithWaitTimeout(2*time.Second))
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	calls := client.setCalls()
	if len(calls) != 3 {
		t.Fatalf("SetNX calls = %d, want 3", len(calls))
	}
	for i, c := range calls {
		if c.value != lock.Token() {
			t.Errorf("attempt %d used token %q, want the same token %q on every retry", i, c.value, lock.Token())
		}
	}
}

func TestDistlockCoverage_WithAutoRenewOverridesConfig(t *testing.T) {
	t.Run("off beats the default", func(t *testing.T) {
		client := &covClient{}
		lock, err := New(Config{Client: client}).Acquire(context.Background(), "k",
			WithTTL(15*time.Millisecond), WithAutoRenew(false))
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(60 * time.Millisecond)
		if n := len(client.renewCalls()); n != 0 {
			t.Errorf("renew calls = %d, want 0 with auto-renew off", n)
		}
		if err := lock.Release(context.Background()); err != nil {
			t.Errorf("Release: %v", err)
		}
	})

	t.Run("on beats DisableAutoRenew", func(t *testing.T) {
		client := &covClient{}
		// A 15ms TTL gives a 5ms period, which is floored at 10ms.
		lock, err := New(Config{Client: client, DisableAutoRenew: true}).Acquire(context.Background(), "k",
			WithTTL(15*time.Millisecond), WithAutoRenew(true))
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		if err := lock.Release(context.Background()); err != nil {
			t.Errorf("Release: %v", err)
		}

		renews := client.renewCalls()
		// 100ms at the 10ms floor allows at most ~10 renewals; an unfloored 5ms period would give ~20.
		if len(renews) < 1 || len(renews) > 12 {
			t.Fatalf("renew calls = %d, want between 1 and 12", len(renews))
		}
		if len(renews[0]) != 2 || renews[0][0] != lock.Token() || renews[0][1] != int64(15) {
			t.Errorf("renew args = %v, want [token, 15 (ttl in ms)]", renews[0])
		}

		// A tick already taken when Release ran may still issue one call; let it drain first.
		time.Sleep(20 * time.Millisecond)
		settled := len(client.renewCalls())
		time.Sleep(50 * time.Millisecond)
		if n := len(client.renewCalls()); n != settled {
			t.Errorf("renewals continued after Release: %d -> %d", settled, n)
		}
	})
}

func TestDistlockCoverage_RenewalInterruptedByReleaseDoesNotMarkLost(t *testing.T) {
	renewStarted := make(chan struct{})
	var once sync.Once
	client := &covClient{}
	client.eval = func(ctx context.Context, script string, _ []string, _ []any) (any, error) {
		if script == RenewLockLua {
			once.Do(func() { close(renewStarted) })
			<-ctx.Done() // in flight until Release stops the watchdog
			return nil, ctx.Err()
		}
		return int64(1), nil
	}

	lock, err := New(Config{Client: client}).Acquire(context.Background(), "k", WithTTL(30*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-renewStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog never renewed")
	}
	// Let more than a full TTL pass, so an error from the renewal would count as a lost lease.
	time.Sleep(50 * time.Millisecond)

	if err := lock.Release(context.Background()); err != nil {
		t.Fatalf("Release = %v, want nil", err)
	}
	time.Sleep(30 * time.Millisecond)
	if covIsLost(lock) {
		t.Error("a renewal cancelled by Release must not mark the lock lost")
	}
	if err := lock.Release(context.Background()); err != nil {
		t.Errorf("second Release = %v, want nil (idempotent)", err)
	}
}

func TestDistlockCoverage_DoRunsFnAndReleasesWithTheLockToken(t *testing.T) {
	var released []any
	client := &covClient{}
	client.eval = func(_ context.Context, script string, keys []string, args []any) (any, error) {
		if script == ReleaseLockLua {
			released = append(released, keys[0], args[0])
		}
		return int64(1), nil
	}

	var fnErr error
	err := New(Config{Client: client, DisableAutoRenew: true}).Do(context.Background(), "jobs:9", func(ctx context.Context) error {
		fnErr = ctx.Err()
		return nil
	})
	if err != nil || fnErr != nil {
		t.Fatalf("Do = %v, fn ctx err = %v; want both nil", err, fnErr)
	}
	token := client.setCalls()[0].value
	if len(released) != 2 || released[0] != "jobs:9" || released[1] != token {
		t.Errorf("release = %v, want [jobs:9 %s]", released, token)
	}
}

func TestDistlockCoverage_DoJoinsFnErrorWithLostLease(t *testing.T) {
	client := &covClient{}
	client.eval = func(context.Context, string, []string, []any) (any, error) {
		return int64(0), nil // the key is no longer ours at release time
	}
	fnErr := errors.New("work failed")

	err := New(Config{Client: client, DisableAutoRenew: true}).Do(context.Background(), "k", func(context.Context) error {
		return fnErr
	})
	if !errors.Is(err, fnErr) || !errors.Is(err, ErrLockLost) {
		t.Fatalf("Do = %v, want both the fn error and ErrLockLost", err)
	}
}

func TestDistlockCoverage_DoReturnsFnErrorAloneWhenReleaseSucceeds(t *testing.T) {
	fnErr := errors.New("work failed")
	err := New(Config{Client: &covClient{}, DisableAutoRenew: true}).Do(context.Background(), "k", func(context.Context) error {
		return fnErr
	})
	if err != fnErr {
		t.Fatalf("Do = %v, want exactly the fn error", err)
	}
}

package distlock

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mockEntry struct {
	token     string
	expiresAt time.Time
}

type mockRedisClient struct {
	mu         sync.Mutex
	store      map[string]mockEntry
	setNXCalls int64
	evalCalls  int64
	// evalHook, when set, runs before each Eval; a non-nil error is returned as-is.
	evalHook func(script string) error
}

func newMockRedis() *mockRedisClient {
	return &mockRedisClient{
		store: make(map[string]mockEntry),
	}
}

func (m *mockRedisClient) SetNX(ctx context.Context, key string, value string, ttl time.Duration) (bool, error) {
	atomic.AddInt64(&m.setNXCalls, 1)
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	if entry, exists := m.store[key]; exists && entry.expiresAt.After(now) {
		return false, nil
	}
	m.store[key] = mockEntry{token: value, expiresAt: now.Add(ttl)}
	return true, nil
}

func (m *mockRedisClient) Eval(ctx context.Context, script string, keys []string, args ...any) (any, error) {
	atomic.AddInt64(&m.evalCalls, 1)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.evalHook != nil {
		if err := m.evalHook(script); err != nil {
			return nil, err
		}
	}

	if len(keys) == 0 {
		return int64(0), nil
	}
	key := keys[0]
	now := time.Now()
	entry, exists := m.store[key]

	if script == ReleaseLockLua {
		if len(args) == 0 {
			return int64(0), nil
		}
		token := fmtArg(args[0])
		if exists && entry.token == token && entry.expiresAt.After(now) {
			delete(m.store, key)
			return int64(1), nil
		}
		return int64(0), nil
	}

	if script == RenewLockLua {
		if len(args) < 2 {
			return int64(0), nil
		}
		token := fmtArg(args[0])
		ttlMs := toInt64(args[1])
		if exists && entry.token == token && entry.expiresAt.After(now) {
			m.store[key] = mockEntry{token: entry.token, expiresAt: now.Add(time.Duration(ttlMs) * time.Millisecond)}
			return int64(1), nil
		}
		return int64(0), nil
	}

	return int64(0), nil
}

func fmtArg(a any) string {
	if s, ok := a.(string); ok {
		return s
	}
	return ""
}

func toInt64(a any) int64 {
	switch v := a.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	default:
		return 0
	}
}

func TestAcquireAndRelease(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 5 * time.Second})

	ctx := context.Background()
	lock, err := locker.Acquire(ctx, "lock:res:1")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}

	client.mu.Lock()
	entry, exists := client.store["lock:res:1"]
	client.mu.Unlock()

	if !exists || entry.token != lock.Token() {
		t.Fatalf("expected lock key in store with matching token")
	}

	if err := lock.Release(ctx); err != nil {
		t.Fatalf("Release failed: %v", err)
	}

	client.mu.Lock()
	_, existsAfter := client.store["lock:res:1"]
	client.mu.Unlock()

	if existsAfter {
		t.Fatalf("expected lock key to be deleted after release")
	}
}

func TestContentionFailFast(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 5 * time.Second})

	ctx := context.Background()
	l1, err := locker.Acquire(ctx, "lock:res:contend")
	if err != nil {
		t.Fatalf("l1 acquire failed: %v", err)
	}
	defer l1.Release(ctx)

	_, err2 := locker.Acquire(ctx, "lock:res:contend", WithWaitTimeout(0))
	if err2 != ErrLockNotAcquired {
		t.Fatalf("expected ErrLockNotAcquired, got %v", err2)
	}
}

func TestContentionWithTimeout(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 5 * time.Second})

	ctx := context.Background()
	l1, err := locker.Acquire(ctx, "lock:res:wait")
	if err != nil {
		t.Fatalf("l1 acquire failed: %v", err)
	}

	go func() {
		time.Sleep(30 * time.Millisecond)
		_ = l1.Release(ctx)
	}()

	l2, err2 := locker.Acquire(ctx, "lock:res:wait", WithWaitTimeout(200*time.Millisecond), WithRetryInterval(10*time.Millisecond))
	if err2 != nil {
		t.Fatalf("l2 acquire failed: %v", err2)
	}
	defer l2.Release(ctx)
}

func TestMutualExclusionConcurrency(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{
		Client:        client,
		DefaultTTL:    5 * time.Second,
		RetryInterval: 10 * time.Millisecond,
	})

	ctx := context.Background()
	var concurrentCount int64
	var maxConcurrent int64
	var completedCount int64

	var wg sync.WaitGroup
	callers := 20

	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := locker.Do(ctx, "lock:mutual", func(c context.Context) error {
				curr := atomic.AddInt64(&concurrentCount, 1)
				for {
					oldMax := atomic.LoadInt64(&maxConcurrent)
					if curr <= oldMax || atomic.CompareAndSwapInt64(&maxConcurrent, oldMax, curr) {
						break
					}
				}
				time.Sleep(10 * time.Millisecond)
				atomic.AddInt64(&concurrentCount, -1)
				atomic.AddInt64(&completedCount, 1)
				return nil
			}, WithWaitTimeout(2*time.Second))

			if err != nil {
				t.Errorf("Do failed: %v", err)
			}
		}()
	}

	wg.Wait()

	if completed := atomic.LoadInt64(&completedCount); completed != int64(callers) {
		t.Fatalf("expected %d completed, got %d", callers, completed)
	}
	if max := atomic.LoadInt64(&maxConcurrent); max != 1 {
		t.Fatalf("VIOLATION: expected max concurrent 1, got %d", max)
	}
}

func TestWatchdogRenewal(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{
		Client:     client,
		DefaultTTL: 60 * time.Millisecond, // Short TTL
		AutoRenew:  true,
	})

	ctx := context.Background()
	lock, err := locker.Acquire(ctx, "lock:watchdog")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}

	// Sleep 120ms (2x TTL)
	time.Sleep(120 * time.Millisecond)

	client.mu.Lock()
	entry, exists := client.store["lock:watchdog"]
	client.mu.Unlock()

	if !exists || entry.expiresAt.Before(time.Now()) {
		t.Fatalf("expected lock to still be active due to watchdog renewal")
	}

	_ = lock.Release(ctx)

	client.mu.Lock()
	_, existsAfter := client.store["lock:watchdog"]
	client.mu.Unlock()

	if existsAfter {
		t.Fatalf("expected lock to be released")
	}
}

func (m *mockRedisClient) get(key string) (mockEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.store[key]
	return e, ok
}

func (m *mockRedisClient) takeOver(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store[key] = mockEntry{token: "other-owner", expiresAt: time.Now().Add(5 * time.Second)}
}

func TestDefaultConfigAutoRenews(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 60 * time.Millisecond})

	var held bool
	err := locker.Do(context.Background(), "lock:default-renew", func(ctx context.Context) error {
		time.Sleep(150 * time.Millisecond) // 2.5x the TTL
		entry, ok := client.get("lock:default-renew")
		held = ok && entry.expiresAt.After(time.Now())
		return nil
	})
	if err != nil {
		t.Fatalf("Do failed: %v", err)
	}
	if !held {
		t.Fatalf("expected default config to keep the lease alive past the TTL")
	}
}

func TestDisableAutoRenew(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 60 * time.Millisecond, DisableAutoRenew: true})

	lock, err := locker.Acquire(context.Background(), "lock:no-renew")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if calls := atomic.LoadInt64(&client.evalCalls); calls != 0 {
		t.Fatalf("expected no renewal calls, got %d", calls)
	}
	if err := lock.Release(context.Background()); err != nil {
		t.Fatalf("Release failed: %v", err)
	}
}

func TestDoReportsLockLost(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 60 * time.Millisecond})

	var cause error
	err := locker.Do(context.Background(), "lock:lost", func(ctx context.Context) error {
		client.takeOver("lock:lost") // another instance now owns the key
		select {
		case <-ctx.Done():
			cause = context.Cause(ctx)
		case <-time.After(time.Second):
		}
		return nil
	})

	if !errors.Is(cause, ErrLockLost) {
		t.Fatalf("expected fn ctx cancelled with cause ErrLockLost, got %v", cause)
	}
	if !errors.Is(err, ErrLockLost) {
		t.Fatalf("expected Do to return ErrLockLost, got %v", err)
	}
	if entry, ok := client.get("lock:lost"); !ok || entry.token != "other-owner" {
		t.Fatalf("expected the new owner's key to be left alone")
	}
}

func TestReleaseReportsLostLease(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 60 * time.Millisecond})

	lock, err := locker.Acquire(context.Background(), "lock:lost-release")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}
	client.takeOver("lock:lost-release")

	select {
	case <-lock.Lost():
	case <-time.After(time.Second):
		t.Fatalf("expected Lost() to be signalled after a renewal returned 0")
	}
	if err := lock.Release(context.Background()); !errors.Is(err, ErrLockLost) {
		t.Fatalf("expected Release to return ErrLockLost, got %v", err)
	}
}

func TestWatchdogRetriesAfterTransientError(t *testing.T) {
	client := newMockRedis()
	var renewCalls int64
	client.evalHook = func(script string) error {
		if script == RenewLockLua && atomic.AddInt64(&renewCalls, 1) == 1 {
			return errors.New("connection reset")
		}
		return nil
	}
	locker := New(Config{Client: client, DefaultTTL: 90 * time.Millisecond})

	lock, err := locker.Acquire(context.Background(), "lock:blip")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // well past the TTL

	if entry, ok := client.get("lock:blip"); !ok || entry.expiresAt.Before(time.Now()) {
		t.Fatalf("expected the lease to keep being extended after one failed renewal")
	}
	if err := lock.Release(context.Background()); err != nil {
		t.Fatalf("Release failed: %v", err)
	}
	if _, ok := client.get("lock:blip"); ok {
		t.Fatalf("expected lock to be released")
	}
}

func TestWatchdogFailsClosedWhenRenewalsFailPastTTL(t *testing.T) {
	client := newMockRedis()
	client.evalHook = func(script string) error {
		if script == RenewLockLua {
			return errors.New("redis down")
		}
		return nil
	}
	locker := New(Config{Client: client, DefaultTTL: 60 * time.Millisecond})

	lock, err := locker.Acquire(context.Background(), "lock:outage")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}
	defer lock.Release(context.Background())

	select {
	case <-lock.Lost():
	case <-time.After(time.Second):
		t.Fatalf("expected Lost() once renewals failed for a full TTL")
	}
}

func TestReleaseCanBeRetriedAfterFailure(t *testing.T) {
	client := newMockRedis()
	locker := New(Config{Client: client, DefaultTTL: 5 * time.Second})

	lock, err := locker.Acquire(context.Background(), "lock:retry-release")
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lock.Release(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected first Release to fail with context.Canceled, got %v", err)
	}
	if _, ok := client.get("lock:retry-release"); !ok {
		t.Fatalf("precondition: key should still be held after the failed release")
	}

	if err := lock.Release(context.Background()); err != nil {
		t.Fatalf("retried Release failed: %v", err)
	}
	if _, ok := client.get("lock:retry-release"); ok {
		t.Fatalf("expected the retried Release to delete the key")
	}
	if err := lock.Release(context.Background()); err != nil {
		t.Fatalf("Release after success must be a no-op, got %v", err)
	}
}

func TestDoSurfacesReleaseError(t *testing.T) {
	client := newMockRedis()
	releaseErr := errors.New("release failed")
	client.evalHook = func(script string) error {
		if script == ReleaseLockLua {
			return releaseErr
		}
		return nil
	}
	locker := New(Config{Client: client, DefaultTTL: 5 * time.Second})

	fnErr := errors.New("fn failed")
	err := locker.Do(context.Background(), "lock:do-release", func(ctx context.Context) error { return fnErr })
	if !errors.Is(err, releaseErr) || !errors.Is(err, fnErr) {
		t.Fatalf("expected Do to surface both fn and release errors, got %v", err)
	}

	err = locker.Do(context.Background(), "lock:do-release-2", func(ctx context.Context) error { return nil })
	if !errors.Is(err, releaseErr) {
		t.Fatalf("expected Do to surface the release error, got %v", err)
	}
}

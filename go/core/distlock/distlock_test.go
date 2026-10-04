package distlock

import (
	"context"
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
	m.mu.Lock()
	defer m.mu.Unlock()

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

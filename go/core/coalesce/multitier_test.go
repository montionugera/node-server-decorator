package coalesce

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type mockMGetCache struct {
	mu        sync.Mutex
	data      map[string][]byte
	mgetCalls int32
	setCalls  int32
	delCalls  int32
}

func newMockCache() *mockMGetCache {
	return &mockMGetCache{data: make(map[string][]byte)}
}

func (m *mockMGetCache) MGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	atomic.AddInt32(&m.mgetCalls, 1)
	m.mu.Lock()
	defer m.mu.Unlock()
	res := make(map[string][]byte)
	for _, k := range keys {
		if val, ok := m.data[k]; ok {
			res[k] = val
		}
	}
	return res, nil
}

func (m *mockMGetCache) SetMany(ctx context.Context, items map[string][]byte, ttl time.Duration) error {
	atomic.AddInt32(&m.setCalls, 1)
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, v := range items {
		m.data[k] = v
	}
	return nil
}

func (m *mockMGetCache) Delete(ctx context.Context, keys ...string) error {
	atomic.AddInt32(&m.delCalls, 1)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range keys {
		delete(m.data, k)
	}
	return nil
}

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func TestMultiTier_L1Hit(t *testing.T) {
	var l3Calls int32
	cache := newMockCache()

	loader := NewMultiTierLoader(MultiTierConfig[string, *User]{
		L1Capacity:   100,
		L1TTL:        5 * time.Second,
		L2Cache:      cache,
		BatchTimeout: 10 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*User, error) {
			atomic.AddInt32(&l3Calls, 1)
			res := make(map[string]*User)
			for _, k := range keys {
				res[k] = &User{ID: k, Name: "User " + k}
			}
			return res, nil
		},
		Serialize: func(u *User) ([]byte, error) {
			return json.Marshal(u)
		},
		Deserialize: func(b []byte) (*User, error) {
			var u User
			err := json.Unmarshal(b, &u)
			return &u, err
		},
	})
	defer loader.Close()

	// Prime L1 directly
	loader.l1.Set("u1", multiTierHolder[*User]{value: &User{ID: "u1", Name: "Primed User"}}, 5*time.Second)

	ctx := context.Background()
	u, err := loader.Load(ctx, "u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if u.Name != "Primed User" {
		t.Fatalf("expected Primed User, got %s", u.Name)
	}
	if atomic.LoadInt32(&l3Calls) != 0 {
		t.Fatalf("expected 0 L3 calls on L1 hit, got %d", l3Calls)
	}
	if atomic.LoadInt32(&cache.mgetCalls) != 0 {
		t.Fatalf("expected 0 L2 MGet calls on L1 hit, got %d", cache.mgetCalls)
	}
}

func TestMultiTier_L2Hit_Backfill(t *testing.T) {
	var l3Calls int32
	cache := newMockCache()

	// Pre-populate L2
	uBytes, _ := json.Marshal(&User{ID: "u2", Name: "From Redis"})
	_ = cache.SetMany(context.Background(), map[string][]byte{"u2": uBytes}, 5*time.Minute)

	loader := NewMultiTierLoader(MultiTierConfig[string, *User]{
		L1Capacity:   100,
		L1TTL:        5 * time.Second,
		L2Cache:      cache,
		BatchTimeout: 10 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*User, error) {
			atomic.AddInt32(&l3Calls, 1)
			return nil, nil
		},
		Serialize: func(u *User) ([]byte, error) {
			return json.Marshal(u)
		},
		Deserialize: func(b []byte) (*User, error) {
			var u User
			err := json.Unmarshal(b, &u)
			return &u, err
		},
	})
	defer loader.Close()

	ctx := context.Background()
	u, err := loader.Load(ctx, "u2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if u.Name != "From Redis" {
		t.Fatalf("expected 'From Redis', got %s", u.Name)
	}
	if atomic.LoadInt32(&l3Calls) != 0 {
		t.Fatalf("expected 0 L3 calls, got %d", l3Calls)
	}

	// Next call should hit L1 without MGet
	atomic.StoreInt32(&cache.mgetCalls, 0)
	u2, err := loader.Load(ctx, "u2")
	if err != nil || u2.Name != "From Redis" {
		t.Fatalf("expected L1 hit on second load, got %v", err)
	}
	if atomic.LoadInt32(&cache.mgetCalls) != 0 {
		t.Fatalf("expected 0 L2 MGet calls on L1 hit, got %d", cache.mgetCalls)
	}
}

func TestMultiTier_L3Hit_BackfillBoth(t *testing.T) {
	var l3Calls int32
	cache := newMockCache()

	loader := NewMultiTierLoader(MultiTierConfig[string, *User]{
		L1Capacity:   100,
		L1TTL:        5 * time.Second,
		L2Cache:      cache,
		BatchTimeout: 10 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*User, error) {
			atomic.AddInt32(&l3Calls, 1)
			res := make(map[string]*User)
			for _, k := range keys {
				res[k] = &User{ID: k, Name: "DB " + k}
			}
			return res, nil
		},
		Serialize: func(u *User) ([]byte, error) {
			return json.Marshal(u)
		},
		Deserialize: func(b []byte) (*User, error) {
			var u User
			err := json.Unmarshal(b, &u)
			return &u, err
		},
	})
	defer loader.Close()

	ctx := context.Background()
	u, err := loader.Load(ctx, "u3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if u.Name != "DB u3" {
		t.Fatalf("expected 'DB u3', got %s", u.Name)
	}
	if atomic.LoadInt32(&l3Calls) != 1 {
		t.Fatalf("expected 1 L3 call, got %d", l3Calls)
	}

	// Verify L2 has it backfilled
	time.Sleep(20 * time.Millisecond)
	if _, ok := cache.data["u3"]; !ok {
		t.Fatalf("expected L2 to have u3 backfilled")
	}

	// Verify L1 has it
	if holder, ok := loader.l1.Get("u3"); !ok || holder.value.Name != "DB u3" {
		t.Fatalf("expected L1 to have u3 backfilled")
	}
}

func TestMultiTier_NegativeCaching(t *testing.T) {
	var l3Calls int32
	cache := newMockCache()

	loader := NewMultiTierLoader(MultiTierConfig[string, *User]{
		L1Capacity:   100,
		L1TTL:        5 * time.Second,
		NegativeTTL:  2 * time.Second,
		L2Cache:      cache,
		BatchTimeout: 10 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*User, error) {
			atomic.AddInt32(&l3Calls, 1)
			// Return empty map = missing
			return map[string]*User{}, nil
		},
		Serialize: func(u *User) ([]byte, error) { return json.Marshal(u) },
		Deserialize: func(b []byte) (*User, error) {
			var u User
			return &u, json.Unmarshal(b, &u)
		},
	})
	defer loader.Close()

	ctx := context.Background()
	u, err := loader.Load(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if u != nil {
		t.Fatalf("expected nil for missing item, got %v", u)
	}
	if atomic.LoadInt32(&l3Calls) != 1 {
		t.Fatalf("expected 1 L3 call, got %d", l3Calls)
	}

	// Second load should hit negative cache and NOT call L3
	u2, err := loader.Load(ctx, "nonexistent")
	if err != nil || u2 != nil {
		t.Fatalf("expected nil from negative cache, got %v", err)
	}
	if atomic.LoadInt32(&l3Calls) != 1 {
		t.Fatalf("expected still 1 L3 call after negative cache hit, got %d", l3Calls)
	}
}

func TestMultiTier_Clear(t *testing.T) {
	cache := newMockCache()
	cache.data["u4"] = []byte(`{"id":"u4","name":"User 4"}`)

	loader := NewMultiTierLoader(MultiTierConfig[string, *User]{
		L1Capacity: 100,
		L2Cache:    cache,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*User, error) {
			return nil, nil
		},
	})
	defer loader.Close()

	loader.l1.Set("u4", multiTierHolder[*User]{value: &User{ID: "u4", Name: "User 4"}}, 5*time.Second)

	ctx := context.Background()
	if err := loader.Clear(ctx, "u4"); err != nil {
		t.Fatalf("unexpected error on Clear: %v", err)
	}

	if _, ok := loader.l1.Get("u4"); ok {
		t.Fatalf("expected u4 to be removed from L1")
	}
	if _, ok := cache.data["u4"]; ok {
		t.Fatalf("expected u4 to be removed from L2")
	}
}

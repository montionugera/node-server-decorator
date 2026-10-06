package coalesce

import (
	"sync"
	"testing"
	"time"
)

func TestLRUGetMissReturnsZeroValue(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	v, ok := c.Get("absent")
	if ok || v != 0 {
		t.Fatalf("Get(absent) = (%d, %v), want (0, false)", v, ok)
	}
	if c.Len() != 0 {
		t.Fatalf("Len = %d, want 0", c.Len())
	}
}

func TestLRUStoresZeroValuesAsHits(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	c.Set("zero", 0, 0)
	v, ok := c.Get("zero")
	if !ok || v != 0 {
		t.Fatalf("Get(zero) = (%d, %v), want a hit holding 0", v, ok)
	}
}

func TestLRUEvictsLeastRecentlyUsedAtCapacity(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	c.Set("a", 1, 0)
	c.Set("b", 2, 0)
	if _, ok := c.Get("a"); !ok { // a becomes most recent, b is now the eviction candidate
		t.Fatal("a missing before eviction")
	}
	c.Set("c", 3, 0)

	if c.Len() != 2 {
		t.Fatalf("Len = %d, want capacity 2", c.Len())
	}
	if _, ok := c.Get("b"); ok {
		t.Fatal("b should have been evicted as least recently used")
	}
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatalf("a = (%d, %v), want (1, true)", v, ok)
	}
	if v, ok := c.Get("c"); !ok || v != 3 {
		t.Fatalf("c = (%d, %v), want (3, true)", v, ok)
	}
}

func TestLRUUpdateRefreshesRecencyWithoutGrowing(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	c.Set("a", 1, 0)
	c.Set("b", 2, 0)
	c.Set("a", 10, 0) // update in place: no eviction, a becomes most recent

	if c.Len() != 2 {
		t.Fatalf("Len after update = %d, want 2", c.Len())
	}
	c.Set("c", 3, 0)
	if _, ok := c.Get("b"); ok {
		t.Fatal("b should be evicted: updating a made b the oldest")
	}
	if v, ok := c.Get("a"); !ok || v != 10 {
		t.Fatalf("a = (%d, %v), want the updated (10, true)", v, ok)
	}
}

func TestLRUCapacityOneKeepsOnlyNewest(t *testing.T) {
	c := NewLRU[int, string](1, 0)
	c.Set(1, "one", 0)
	c.Set(2, "two", 0)
	if _, ok := c.Get(1); ok {
		t.Fatal("key 1 should be evicted at capacity 1")
	}
	if v, ok := c.Get(2); !ok || v != "two" || c.Len() != 1 {
		t.Fatalf("key 2 = (%q, %v), Len = %d", v, ok, c.Len())
	}
}

func TestLRUNonPositiveCapacityIsUnbounded(t *testing.T) {
	for _, capacity := range []int{0, -5} {
		c := NewLRU[int, int](capacity, 0)
		for i := 0; i < 500; i++ {
			c.Set(i, i, 0)
		}
		if c.Len() != 500 {
			t.Fatalf("capacity %d: Len = %d, want all 500 retained", capacity, c.Len())
		}
		if v, ok := c.Get(0); !ok || v != 0 {
			t.Fatalf("capacity %d: oldest entry evicted", capacity)
		}
	}
}

func TestLRUExpiredEntryIsRemovedOnGet(t *testing.T) {
	c := NewLRU[string, int](10, 0)
	c.Set("k", 1, 15*time.Millisecond)
	if v, ok := c.Get("k"); !ok || v != 1 {
		t.Fatalf("fresh entry = (%d, %v), want (1, true)", v, ok)
	}

	time.Sleep(40 * time.Millisecond)
	if c.Len() != 1 {
		t.Fatalf("Len before lazy expiry = %d, want 1", c.Len())
	}
	if v, ok := c.Get("k"); ok || v != 0 {
		t.Fatalf("expired entry = (%d, %v), want (0, false)", v, ok)
	}
	if c.Len() != 0 {
		t.Fatalf("Len after expired Get = %d, want the entry removed", c.Len())
	}
}

func TestLRUZeroTTLUsesDefaultTTL(t *testing.T) {
	c := NewLRU[string, int](10, 15*time.Millisecond)
	c.Set("k", 1, 0)
	time.Sleep(40 * time.Millisecond)
	if _, ok := c.Get("k"); ok {
		t.Fatal("entry set with ttl 0 outlived the default TTL")
	}
}

func TestLRUNoTTLNeverExpires(t *testing.T) {
	c := NewLRU[string, int](10, 0) // default 0 and ttl 0: no expiry at all
	c.Set("k", 1, 0)
	time.Sleep(20 * time.Millisecond)
	if v, ok := c.Get("k"); !ok || v != 1 {
		t.Fatalf("entry without any TTL = (%d, %v), want (1, true)", v, ok)
	}
}

func TestLRUNegativeTTLOverridesDefaultWithNoExpiry(t *testing.T) {
	c := NewLRU[string, int](10, 10*time.Millisecond)
	c.Set("k", 1, -1)
	time.Sleep(30 * time.Millisecond)
	if v, ok := c.Get("k"); !ok || v != 1 {
		t.Fatalf("entry set with negative ttl = (%d, %v), want it to never expire", v, ok)
	}
}

func TestLRUUpdateReplacesExpiry(t *testing.T) {
	c := NewLRU[string, int](10, 0)
	c.Set("k", 1, 15*time.Millisecond)
	c.Set("k", 2, time.Hour)
	time.Sleep(40 * time.Millisecond)
	if v, ok := c.Get("k"); !ok || v != 2 {
		t.Fatalf("updated entry = (%d, %v), want (2, true) under the new TTL", v, ok)
	}
}

func TestLRUDelete(t *testing.T) {
	c := NewLRU[string, int](10, 0)
	c.Set("a", 1, 0)
	c.Set("b", 2, 0)

	if !c.Delete("a") {
		t.Fatal("Delete(a) = false, want true for a present key")
	}
	if c.Delete("a") {
		t.Fatal("second Delete(a) = true, want false")
	}
	if c.Delete("never") {
		t.Fatal("Delete(never) = true, want false")
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("a still readable after Delete")
	}
	if v, ok := c.Get("b"); !ok || v != 2 || c.Len() != 1 {
		t.Fatalf("b = (%d, %v), Len = %d; Delete(a) must not disturb b", v, ok, c.Len())
	}
}

func TestLRUDeleteFreesCapacitySlot(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	c.Set("a", 1, 0)
	c.Set("b", 2, 0)
	c.Delete("a")
	c.Set("c", 3, 0)
	if _, ok := c.Get("b"); !ok {
		t.Fatal("b was evicted although Delete had freed a slot")
	}
}

func TestLRUClearEmptiesAndStaysUsable(t *testing.T) {
	c := NewLRU[string, int](2, 0)
	c.Set("a", 1, 0)
	c.Set("b", 2, 0)
	c.Clear()

	if c.Len() != 0 {
		t.Fatalf("Len after Clear = %d, want 0", c.Len())
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("a readable after Clear")
	}
	c.Set("x", 9, 0)
	c.Set("y", 8, 0)
	c.Set("z", 7, 0)
	if c.Len() != 2 {
		t.Fatalf("Len after refilling = %d, want capacity 2 still enforced", c.Len())
	}
	if _, ok := c.Get("x"); ok {
		t.Fatal("x should be evicted after Clear + refill past capacity")
	}
}

func TestLRUConcurrentAccessKeepsCapacityInvariant(t *testing.T) {
	c := NewLRU[int, int](16, 0)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				k := (g*31 + i) % 64
				c.Set(k, k, 0)
				if v, ok := c.Get(k); ok && v != k {
					t.Errorf("key %d holds %d", k, v)
				}
				if i%7 == 0 {
					c.Delete(k)
				}
			}
		}(g)
	}
	wg.Wait()
	if n := c.Len(); n > 16 {
		t.Fatalf("Len = %d, exceeds capacity 16", n)
	}
}

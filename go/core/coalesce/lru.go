package coalesce

import (
	"container/list"
	"sync"
	"time"
)

type lruEntry[K comparable, V any] struct {
	key       K
	value     V
	expiresAt time.Time
}

// LRU is a pure Go standard library thread-safe in-memory cache with bounded capacity and TTL.
type LRU[K comparable, V any] struct {
	mu         sync.RWMutex
	capacity   int
	defaultTTL time.Duration
	items      map[K]*list.Element
	evictList  *list.List
}

// NewLRU creates a new bounded LRU cache. If capacity <= 0, capacity is unlimited.
func NewLRU[K comparable, V any](capacity int, defaultTTL time.Duration) *LRU[K, V] {
	return &LRU[K, V]{
		capacity:   capacity,
		defaultTTL: defaultTTL,
		items:      make(map[K]*list.Element),
		evictList:  list.New(),
	}
}

// Get retrieves an item from the cache. Returns false if not found or expired.
func (c *LRU[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		var zero V
		return zero, false
	}

	entry := elem.Value.(*lruEntry[K, V])
	if !entry.expiresAt.IsZero() && time.Now().After(entry.expiresAt) {
		c.removeElement(elem)
		var zero V
		return zero, false
	}

	c.evictList.MoveToFront(elem)
	return entry.value, true
}

// Set adds or updates an item in the cache with the given TTL.
func (c *LRU[K, V]) Set(key K, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if ttl == 0 {
		ttl = c.defaultTTL
	}

	var expiresAt time.Time
	if ttl > 0 {
		expiresAt = time.Now().Add(ttl)
	}

	if elem, ok := c.items[key]; ok {
		c.evictList.MoveToFront(elem)
		entry := elem.Value.(*lruEntry[K, V])
		entry.value = value
		entry.expiresAt = expiresAt
		return
	}

	if c.capacity > 0 && c.evictList.Len() >= c.capacity {
		c.removeOldest()
	}

	entry := &lruEntry[K, V]{
		key:       key,
		value:     value,
		expiresAt: expiresAt,
	}
	elem := c.evictList.PushFront(entry)
	c.items[key] = elem
}

// Delete removes an item from the cache.
func (c *LRU[K, V]) Delete(key K) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.removeElement(elem)
		return true
	}
	return false
}

// Clear purges all items from the cache.
func (c *LRU[K, V]) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.items = make(map[K]*list.Element)
	c.evictList.Init()
}

// Len returns the number of items currently in the cache.
func (c *LRU[K, V]) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.items)
}

func (c *LRU[K, V]) removeOldest() {
	elem := c.evictList.Back()
	if elem != nil {
		c.removeElement(elem)
	}
}

func (c *LRU[K, V]) removeElement(elem *list.Element) {
	c.evictList.Remove(elem)
	entry := elem.Value.(*lruEntry[K, V])
	delete(c.items, entry.key)
}

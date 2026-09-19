package coalesce

import (
	"sync"
)

type call[V any] struct {
	wg  sync.WaitGroup
	val V
	err error
}

// Group provides in-flight deduplication for identical keys.
type Group[K comparable, V any] struct {
	mu sync.Mutex
	m  map[K]*call[V]
}

// NewGroup creates a new SingleFlight group.
func NewGroup[K comparable, V any]() *Group[K, V] {
	return &Group[K, V]{
		m: make(map[K]*call[V]),
	}
}

// Do executes and returns the result of the given function, making
// sure that only one execution is in-flight for a given key at a time.
func (g *Group[K, V]) Do(key K, fn func() (V, error)) (V, error) {
	g.mu.Lock()
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}

	c := new(call[V])
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()
	c.wg.Done()

	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()

	return c.val, c.err
}

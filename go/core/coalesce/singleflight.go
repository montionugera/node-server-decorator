package coalesce

import (
	"fmt"
	"sync"
)

type call[V any] struct {
	wg  sync.WaitGroup
	val V
	err error
	// dups counts the callers that joined this call instead of starting it (guarded by Group.mu).
	dups int
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
		c.dups++
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}

	c := new(call[V])
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	c.val, c.err = fn()

	// Drop the key before waking the waiters: one that retries at once must start a fresh call,
	// not find this finished one still in the map and be handed its result again.
	g.mu.Lock()
	delete(g.m, key)
	g.mu.Unlock()
	c.wg.Done()

	return c.val, c.err
}

// DoChan is like Do but never blocks the caller: the first caller for a key starts fn in its
// own goroutine, and every caller (first or not) gets a channel that yields the shared result.
// Callers can therefore stop waiting (e.g. on their own context) without affecting the others.
//
// fn runs on a goroutine no caller owns, so a panic in it cannot reach a caller's recover and
// would kill the process. It is recovered and delivered to every waiter as an error instead.
func (g *Group[K, V]) DoChan(key K, fn func() (V, error)) <-chan result[V] {
	out := make(chan result[V], 1)

	g.mu.Lock()
	c, ok := g.m[key]
	if !ok {
		c = new(call[V])
		c.wg.Add(1)
		g.m[key] = c
		go func() {
			defer func() {
				if r := recover(); r != nil {
					var zero V
					c.val, c.err = zero, fmt.Errorf("coalesce: panic: %v", r)
				}
				g.mu.Lock()
				delete(g.m, key)
				g.mu.Unlock()
				c.wg.Done()
			}()
			c.val, c.err = fn()
		}()
	}
	g.mu.Unlock()

	go func() {
		c.wg.Wait()
		out <- result[V]{val: c.val, err: c.err}
	}()
	return out
}

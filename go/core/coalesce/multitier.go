package coalesce

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// MGetCache defines the contract for bulk-read, pipelined-write distributed caches (e.g. Redis).
type MGetCache interface {
	MGet(ctx context.Context, keys []string) (map[string][]byte, error)
	SetMany(ctx context.Context, items map[string][]byte, ttl time.Duration) error
	Delete(ctx context.Context, keys ...string) error
}

type multiTierHolder[V any] struct {
	value     V
	isMissing bool
}

// PrefetchHook defines a callback invoked asynchronously when items are resolved.
type PrefetchHook[V any] func(ctx context.Context, items []V)

// MultiTierConfig configures a 3-tier read coalescing pipeline.
type MultiTierConfig[K comparable, V any] struct {
	L1Capacity    int           // Max items in local in-memory LRU (0 = default 10,000)
	L1TTL         time.Duration // In-memory LRU TTL (0 = default 10s)
	L2Cache       MGetCache     // Distributed cache interface (optional)
	L2TTL         time.Duration // Distributed cache TTL (0 = default 5m)
	NegativeTTL   time.Duration // TTL for caching missing/non-existent keys (0 = default 5s)
	MaxBatchSize  int           // Max batch size before immediate dispatch (default 100)
	BatchTimeout  time.Duration // Time window to collect concurrent callers (default 1ms)
	PrefetchHooks []PrefetchHook[V]
	KeyToString   func(K) string
	StringToKey   func(string) K
	BatchFn       func(ctx context.Context, keys []K) (map[K]V, error)
	Serialize     func(V) ([]byte, error)
	Deserialize   func([]byte) (V, error)
}

// MultiTierLoader orchestrates L1 memory, L2 distributed MGET, and L3 database batching.
type MultiTierLoader[K comparable, V any] struct {
	cfg         MultiTierConfig[K, V]
	l1          *LRU[K, multiTierHolder[V]]
	sf          *Group[string, map[K]V]
	mu          sync.Mutex
	activeBatch *multiTierBatch[K, V]
	closed      bool
}

type multiTierRequest[V any] struct {
	result chan V
	err    chan error
}

type multiTierBatch[K comparable, V any] struct {
	keys         []K
	keyMap       map[K]bool
	requests     map[K][]*multiTierRequest[V]
	timer        *time.Timer
	ctx          context.Context
	cancelBatch  context.CancelFunc
	callerCount  int32
	dispatched   bool
}

// NewMultiTierLoader creates a new 3-tier coalescing loader.
func NewMultiTierLoader[K comparable, V any](cfg MultiTierConfig[K, V]) *MultiTierLoader[K, V] {
	if cfg.L1Capacity <= 0 {
		cfg.L1Capacity = 10000
	}
	if cfg.L1TTL <= 0 {
		cfg.L1TTL = 10 * time.Second
	}
	if cfg.L2TTL <= 0 {
		cfg.L2TTL = 5 * time.Minute
	}
	if cfg.NegativeTTL <= 0 {
		cfg.NegativeTTL = 5 * time.Second
	}
	if cfg.MaxBatchSize <= 0 {
		cfg.MaxBatchSize = 100
	}
	if cfg.BatchTimeout <= 0 {
		cfg.BatchTimeout = 1 * time.Millisecond
	}
	if cfg.KeyToString == nil {
		cfg.KeyToString = func(k K) string { return fmt.Sprintf("%v", k) }
	}

	return &MultiTierLoader[K, V]{
		cfg: cfg,
		l1:  NewLRU[K, multiTierHolder[V]](cfg.L1Capacity, cfg.L1TTL),
		sf:  NewGroup[string, map[K]V](),
	}
}

// Load fetches an individual item through the multi-tier coalescing pipeline.
func (l *MultiTierLoader[K, V]) Load(ctx context.Context, key K) (V, error) {
	// 1. Immediate L1 check
	if holder, ok := l.l1.Get(key); ok {
		if holder.isMissing {
			var zero V
			return zero, nil
		}
		return holder.value, nil
	}

	// 2. Queue into active coalescing window
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		var zero V
		return zero, errors.New("loader is closed")
	}

	b := l.activeBatch
	if b == nil {
		batchCtx, cancel := context.WithCancel(context.Background())
		b = &multiTierBatch[K, V]{
			keyMap:      make(map[K]bool),
			requests:    make(map[K][]*multiTierRequest[V]),
			ctx:         batchCtx,
			cancelBatch: cancel,
		}
		l.activeBatch = b
		b.timer = time.AfterFunc(l.cfg.BatchTimeout, func() {
			l.mu.Lock()
			if l.activeBatch == b {
				l.triggerBatch(b)
			}
			l.mu.Unlock()
		})
	}

	atomic.AddInt32(&b.callerCount, 1)
	if !b.keyMap[key] {
		b.keyMap[key] = true
		b.keys = append(b.keys, key)
	}

	req := &multiTierRequest[V]{
		result: make(chan V, 1),
		err:    make(chan error, 1),
	}
	b.requests[key] = append(b.requests[key], req)

	if len(b.keys) >= l.cfg.MaxBatchSize {
		l.triggerBatch(b)
	}
	l.mu.Unlock()

	select {
	case <-ctx.Done():
		remaining := atomic.AddInt32(&b.callerCount, -1)
		if remaining <= 0 {
			b.cancelBatch()
		}
		var zero V
		return zero, ctx.Err()
	case val := <-req.result:
		return val, nil
	case err := <-req.err:
		var zero V
		return zero, err
	}
}

func (l *MultiTierLoader[K, V]) triggerBatch(b *multiTierBatch[K, V]) {
	if b.dispatched {
		return
	}
	b.dispatched = true
	if b.timer != nil {
		b.timer.Stop()
	}
	if l.activeBatch == b {
		l.activeBatch = nil
	}

	go l.dispatchBatch(b)
}

func (l *MultiTierLoader[K, V]) dispatchBatch(b *multiTierBatch[K, V]) {
	keys := b.keys
	reqs := b.requests

	// Phase A: L1 Check
	var l1Misses []K
	for _, key := range keys {
		if holder, ok := l.l1.Get(key); ok {
			var val V
			if !holder.isMissing {
				val = holder.value
			}
			for _, r := range reqs[key] {
				r.result <- val
			}
		} else {
			l1Misses = append(l1Misses, key)
		}
	}

	if len(l1Misses) == 0 {
		return
	}

	// Phase B: L2 Distributed Cache Check (MGET)
	var l2Misses []K
	if l.cfg.L2Cache != nil && l.cfg.Deserialize != nil {
		strKeys := make([]string, len(l1Misses))
		keyMap := make(map[string]K, len(l1Misses))
		for i, k := range l1Misses {
			s := l.cfg.KeyToString(k)
			strKeys[i] = s
			keyMap[s] = k
		}

		mgetRes, err := l.cfg.L2Cache.MGet(b.ctx, strKeys)
		if err == nil && mgetRes != nil {
			for strKey, rawBytes := range mgetRes {
				origKey, exists := keyMap[strKey]
				if !exists {
					continue
				}
				val, dErr := l.cfg.Deserialize(rawBytes)
				if dErr == nil {
					l.l1.Set(origKey, multiTierHolder[V]{value: val}, l.cfg.L1TTL)
					for _, r := range reqs[origKey] {
						r.result <- val
					}
					delete(keyMap, strKey)
				}
			}
		}

		for _, origKey := range keyMap {
			l2Misses = append(l2Misses, origKey)
		}
	} else {
		l2Misses = l1Misses
	}

	if len(l2Misses) == 0 {
		return
	}

	// Phase C: L3 Batch DB Query (via SingleFlight)
	sfKey := fmt.Sprintf("batch:%v", l2Misses)
	resMap, err := l.sf.Do(sfKey, func() (map[K]V, error) {
		return l.cfg.BatchFn(b.ctx, l2Misses)
	})

	if err != nil {
		for _, k := range l2Misses {
			for _, r := range reqs[k] {
				r.err <- err
			}
		}
		return
	}

	var resolvedItems []V
	l2SetItems := make(map[string][]byte)
	for _, k := range l2Misses {
		if val, found := resMap[k]; found {
			resolvedItems = append(resolvedItems, val)
			l.l1.Set(k, multiTierHolder[V]{value: val}, l.cfg.L1TTL)
			if l.cfg.L2Cache != nil && l.cfg.Serialize != nil {
				if bytes, sErr := l.cfg.Serialize(val); sErr == nil {
					l2SetItems[l.cfg.KeyToString(k)] = bytes
				}
			}
			for _, r := range reqs[k] {
				r.result <- val
			}
		} else {
			// Negative caching for non-existent key
			l.l1.Set(k, multiTierHolder[V]{isMissing: true}, l.cfg.NegativeTTL)
			var zero V
			for _, r := range reqs[k] {
				r.result <- zero
			}
		}
	}

	if len(l2SetItems) > 0 && l.cfg.L2Cache != nil {
		_ = l.cfg.L2Cache.SetMany(b.ctx, l2SetItems, l.cfg.L2TTL)
	}

	// Trigger PrefetchHooks asynchronously with detached context
	if len(resolvedItems) > 0 && len(l.cfg.PrefetchHooks) > 0 {
		prefetchCtx, cancel := context.WithTimeout(context.WithoutCancel(b.ctx), 5*time.Second)
		go func(ctx context.Context, items []V) {
			defer cancel()
			for _, hook := range l.cfg.PrefetchHooks {
				hook(ctx, items)
			}
		}(prefetchCtx, resolvedItems)
	}
}

// LoadMany fetches multiple items through the multi-tier coalescing pipeline in parallel.
func (l *MultiTierLoader[K, V]) LoadMany(ctx context.Context, keys []K) (map[K]V, error) {
	if len(keys) == 0 {
		return make(map[K]V), nil
	}

	type keyResult struct {
		key K
		val V
		err error
	}

	results := make(chan keyResult, len(keys))
	var wg sync.WaitGroup

	for _, k := range keys {
		wg.Add(1)
		go func(key K) {
			defer wg.Done()
			val, err := l.Load(ctx, key)
			results <- keyResult{key: key, val: val, err: err}
		}(k)
	}

	wg.Wait()
	close(results)

	resMap := make(map[K]V, len(keys))
	for r := range results {
		if r.err != nil {
			return nil, r.err
		}
		resMap[r.key] = r.val
	}
	return resMap, nil
}

// Prime loads a key-value pair directly into L1 and optional L2 cache without invoking DB queries.
func (l *MultiTierLoader[K, V]) Prime(key K, val V) {
	l.l1.Set(key, multiTierHolder[V]{value: val}, l.cfg.L1TTL)
	if l.cfg.L2Cache != nil && l.cfg.Serialize != nil {
		if bytes, sErr := l.cfg.Serialize(val); sErr == nil {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				_ = l.cfg.L2Cache.SetMany(ctx, map[string][]byte{l.cfg.KeyToString(key): bytes}, l.cfg.L2TTL)
			}()
		}
	}
}

// Prefetch requests keys in a detached background goroutine without blocking the caller.
func (l *MultiTierLoader[K, V]) Prefetch(ctx context.Context, keys []K) {
	if len(keys) == 0 {
		return
	}
	prefetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	go func() {
		defer cancel()
		_, _ = l.LoadMany(prefetchCtx, keys)
	}()
}

// Clear invalidates a key from L1 memory and L2 distributed cache.
func (l *MultiTierLoader[K, V]) Clear(ctx context.Context, key K) error {
	l.l1.Delete(key)
	if l.cfg.L2Cache != nil {
		return l.cfg.L2Cache.Delete(ctx, l.cfg.KeyToString(key))
	}
	return nil
}

// Close gracefully terminates the loader.
func (l *MultiTierLoader[K, V]) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	if l.activeBatch != nil {
		l.triggerBatch(l.activeBatch)
	}
	l.l1.Clear()
}

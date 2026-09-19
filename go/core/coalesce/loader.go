package coalesce

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// BatchFn loads a batch of items by keys and returns a mapping from key to value.
type BatchFn[K comparable, V any] func(ctx context.Context, keys []K) (map[K]V, error)

// Config configures the coalesce Loader.
type Config[K comparable, V any] struct {
	BatchFn      BatchFn[K, V]
	Window       time.Duration
	MaxBatchSize int
	SingleFlight bool
}

type itemRequest[K comparable, V any] struct {
	key    K
	result chan result[V]
}

type result[V any] struct {
	val V
	err error
}

type activeBatch[K comparable, V any] struct {
	ctx         context.Context
	cancelBatch context.CancelFunc
	keys        []K
	requests    map[K][]chan result[V]
	callerCount int32
}

// Loader transparently coalesces multiple individual Load calls into bulk BatchFn executions.
type Loader[K comparable, V any] struct {
	cfg   Config[K, V]
	group *Group[K, V]

	mu       sync.Mutex
	cache    map[K]V
	batch    *activeBatch[K, V]
	timer    *time.Timer
	timerSub bool
}

// New creates a new Loader instance with the given configuration.
func New[K comparable, V any](cfg Config[K, V]) *Loader[K, V] {
	if cfg.Window <= 0 {
		cfg.Window = 1 * time.Millisecond
	}
	if cfg.MaxBatchSize <= 0 {
		cfg.MaxBatchSize = 100
	}

	l := &Loader[K, V]{
		cfg:   cfg,
		cache: make(map[K]V),
	}
	if cfg.SingleFlight {
		l.group = NewGroup[K, V]()
	}
	return l
}

// Prime loads a key-value pair directly into the local loader cache.
func (l *Loader[K, V]) Prime(key K, val V) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cache[key] = val
}

// Load requests a single value by key, coalescing with peers within the configured window.
func (l *Loader[K, V]) Load(ctx context.Context, key K) (V, error) {
	if l.cfg.SingleFlight && l.group != nil {
		return l.group.Do(key, func() (V, error) {
			return l.loadInternal(ctx, key)
		})
	}
	return l.loadInternal(ctx, key)
}

func (l *Loader[K, V]) loadInternal(ctx context.Context, key K) (V, error) {
	l.mu.Lock()
	if val, ok := l.cache[key]; ok {
		l.mu.Unlock()
		return val, nil
	}

	// Check if this context is already cancelled
	if err := ctx.Err(); err != nil {
		l.mu.Unlock()
		var zero V
		return zero, err
	}

	resChan := make(chan result[V], 1)

	if l.batch == nil {
		batchCtx, cancel := context.WithCancel(context.Background())
		l.batch = &activeBatch[K, V]{
			ctx:         batchCtx,
			cancelBatch: cancel,
			keys:        make([]K, 0, l.cfg.MaxBatchSize),
			requests:    make(map[K][]chan result[V]),
		}
		// Schedule window trigger
		l.timer = time.AfterFunc(l.cfg.Window, func() {
			l.dispatchBatch()
		})
	}

	b := l.batch
	atomic.AddInt32(&b.callerCount, 1)

	if _, exists := b.requests[key]; !exists {
		b.keys = append(b.keys, key)
	}
	b.requests[key] = append(b.requests[key], resChan)

	shouldDispatchNow := len(b.keys) >= l.cfg.MaxBatchSize
	if shouldDispatchNow {
		if l.timer != nil {
			l.timer.Stop()
		}
		l.dispatchBatchLocked()
	}
	l.mu.Unlock()

	select {
	case <-ctx.Done():
		// Individual caller cancelled: decrement active count.
		// If all callers detached, cancel the underlying batch query.
		if atomic.AddInt32(&b.callerCount, -1) == 0 {
			b.cancelBatch()
		}
		var zero V
		return zero, ctx.Err()
	case res := <-resChan:
		return res.val, res.err
	}
}

func (l *Loader[K, V]) dispatchBatch() {
	l.mu.Lock()
	l.dispatchBatchLocked()
	l.mu.Unlock()
}

func (l *Loader[K, V]) dispatchBatchLocked() {
	if l.batch == nil {
		return
	}

	currentBatch := l.batch
	l.batch = nil
	l.timer = nil

	go func(b *activeBatch[K, V]) {
		// Execute under batch context isolated from single caller aborts
		results, err := l.cfg.BatchFn(b.ctx, b.keys)
		for _, k := range b.keys {
			chans := b.requests[k]
			for _, ch := range chans {
				if err != nil {
					var zero V
					ch <- result[V]{val: zero, err: err}
				} else {
					ch <- result[V]{val: results[k], err: nil}
				}
			}
		}
	}(currentBatch)
}

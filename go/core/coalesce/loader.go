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
	// SingleFlight deduplicates concurrent Loads of the same key into one shared call.
	//
	// Limit: the shared call runs detached from every caller's cancellation and deadline, so
	// that it cannot die with whichever caller started it. Each caller still returns as soon
	// as its own context ends, but in this mode the batch is never cancelled when all callers
	// have given up, and BatchFn receives a context with no deadline. Bound the query inside
	// BatchFn if it must not outlive its callers.
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
	// deadline is the latest deadline among the callers; it is applied to the batch only
	// when every caller has one (unbounded == false), so no caller is cut short by another.
	deadline  time.Time
	unbounded bool
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
		// The shared call must not die with whichever caller happened to start it: run it
		// detached from cancellation (values are kept) and let every waiter honour its own ctx.
		done := l.group.DoChan(key, func() (V, error) {
			return l.loadInternal(context.WithoutCancel(ctx), key)
		})
		select {
		case <-ctx.Done():
			var zero V
			return zero, ctx.Err()
		case res := <-done:
			return res.val, res.err
		}
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
		// Keep the request values (tenant, auth, trace, tx) of the caller that opens the batch,
		// but not its cancellation: one caller giving up must not abort the others.
		batchCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
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
	if d, ok := ctx.Deadline(); !ok {
		b.unbounded = true
	} else if d.After(b.deadline) {
		b.deadline = d
	}

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
		// Individual caller cancelled: decrement active count. Done under the lock so no
		// caller can join a batch that is being abandoned.
		l.mu.Lock()
		if atomic.AddInt32(&b.callerCount, -1) == 0 {
			if l.batch == b {
				// Still collecting and nobody is waiting: discard it so that a later
				// caller opens a fresh batch instead of joining a cancelled one.
				l.batch = nil
				if l.timer != nil {
					l.timer.Stop()
					l.timer = nil
				}
			}
			// Either discarded or already dispatched with no caller left: stop the query.
			b.cancelBatch()
		}
		l.mu.Unlock()
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
		ctx := b.ctx
		if !b.unbounded && !b.deadline.IsZero() {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, b.deadline)
			defer cancel()
		}
		results, err := l.cfg.BatchFn(ctx, b.keys)
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

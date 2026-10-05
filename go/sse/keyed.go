package sse

import (
	"context"
	"time"
)

// SubscribeKey registers a subscriber that receives only events sent with
// BroadcastTo(key, ...). It returns the receive channel, a dropped func and a
// cancel func.
//
// Keyed and unkeyed subscribers are disjoint: Broadcast and Publish never reach
// a keyed subscriber, and the empty string is an ordinary key.
//
// dropped reports whether an event was discarded for this subscriber (its
// buffer was full, or MarkAllDropped ran) and resets the flag in the same
// atomic step. The flag can be raised while no event arrives, so poll dropped
// on a timer of your own rather than only after a receive.
//
// The subscription ends when cancel is called, ctx is done, or the Broadcaster
// is closed. A nil ctx is allowed: then only cancel or Close ends it.
func (b *Broadcaster[T]) SubscribeKey(ctx context.Context, key string) (events <-chan Event[T], dropped func() bool, cancel func()) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		ch := make(chan Event[T])
		close(ch)
		return ch, func() bool { return false }, func() {}
	}

	id := b.nextSubID
	b.nextSubID++

	sub := &subscriber[T]{
		ch:   make(chan Event[T], b.bufferSize),
		done: make(chan struct{}),
	}
	subs := b.byKey[key]
	if subs == nil {
		subs = make(map[uint64]*subscriber[T])
		b.byKey[key] = subs
	}
	subs[id] = sub
	b.mu.Unlock()

	// Same pattern as subscribe: map membership (checked under b.mu) is what
	// makes cancel idempotent and safe against Close.
	cancel = func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		subs := b.byKey[key]
		if subs[id] != sub {
			return
		}
		delete(subs, id)
		if len(subs) == 0 {
			delete(b.byKey, key)
		}
		close(sub.done)
		close(sub.ch)
	}

	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				cancel()
			case <-sub.done:
			case <-b.done:
				cancel()
			}
		}()
	}

	return sub.ch, func() bool { return sub.dropped.Swap(false) }, cancel
}

// BroadcastTo sends event to the subscribers of key only. It keeps no history,
// so a keyed event is never replayed for a Last-Event-ID.
//
// Sends are non-blocking: a subscriber whose buffer is full misses the event
// (its older buffered events stay) and has its dropped flag set.
func (b *Broadcaster[T]) BroadcastTo(key string, event Event[T]) {
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}

	// The read lock is held for the whole send loop; cancel and Close close
	// channels under the write lock, so this never sends on a closed channel.
	// After Close byKey is empty, which makes this a no-op.
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, sub := range b.byKey[key] {
		select {
		case sub.ch <- event:
		default:
			sub.dropped.Store(true)
		}
	}
}

// MarkAllDropped flags every keyed subscriber as having missed events. It
// sends nothing and closes nothing; each subscriber sees it on its next
// dropped() call. Use it when the upstream event source lost continuity.
func (b *Broadcaster[T]) MarkAllDropped() {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, subs := range b.byKey {
		for _, sub := range subs {
			sub.dropped.Store(true)
		}
	}
}

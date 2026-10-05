package distlock

import (
	"context"
	"sync"
)

// Manager is a try-or-skip lock coordinator. It never waits for a held lock.
//
// Use it to stop two replicas running the same job at once: the replica that
// does not get the lock skips the run. For a lock that waits, renews and
// reports loss, use Locker.
type Manager interface {
	// AcquireLock tries to take the lock for key.
	// acquired is false, with a nil error, when another holder has it.
	// release is never nil. It frees the lock, is idempotent and is safe to defer.
	// Cancelling ctx after a successful acquire does not free the lock.
	AcquireLock(ctx context.Context, key string) (release func(), acquired bool, err error)
}

// noopRelease is the release returned when there is nothing to free.
func noopRelease() {}

// MemoryManager is a process-local Manager for single-replica runs and tests.
// It ignores the context and never returns an error. Use NewMemoryManager.
type MemoryManager struct {
	mu   sync.Mutex
	held map[string]struct{}
}

// NewMemoryManager returns an empty MemoryManager.
func NewMemoryManager() *MemoryManager {
	return &MemoryManager{held: make(map[string]struct{})}
}

// AcquireLock takes the in-process lock for key unless it is already held.
func (m *MemoryManager) AcquireLock(_ context.Context, key string) (func(), bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, taken := m.held[key]; taken {
		return noopRelease, false, nil
	}
	m.held[key] = struct{}{}

	// The Once makes a stale second call a no-op, so it cannot free a later
	// holder of the same key.
	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			delete(m.held, key)
			m.mu.Unlock()
		})
	}
	return release, true, nil
}

// NoopManager always grants the lock. Use it to switch locking off.
type NoopManager struct{}

// NewNoopManager returns a NoopManager.
func NewNoopManager() *NoopManager {
	return &NoopManager{}
}

// AcquireLock always reports acquired with a no-op release.
func (NoopManager) AcquireLock(_ context.Context, _ string) (func(), bool, error) {
	return noopRelease, true, nil
}

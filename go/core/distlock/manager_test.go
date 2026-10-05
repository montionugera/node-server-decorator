package distlock

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestManagerContract(t *testing.T) {
	managers := map[string]func() Manager{
		"memory": func() Manager { return NewMemoryManager() },
		"noop":   func() Manager { return NewNoopManager() },
	}
	for name, build := range managers {
		t.Run(name, func(t *testing.T) {
			m := build()

			// An already cancelled context neither errors nor blocks.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			release, acquired, err := m.AcquireLock(ctx, "k")
			if err != nil || !acquired {
				t.Fatalf("AcquireLock = (acquired %v, err %v), want (true, nil)", acquired, err)
			}
			if release == nil {
				t.Fatal("release is nil on a successful acquire")
			}

			// release is idempotent and safe from any goroutine.
			var wg sync.WaitGroup
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					release()
				}()
			}
			wg.Wait()
			release()
		})
	}
}

func TestMemoryManagerSecondAcquireIsSkippedNotBlocked(t *testing.T) {
	m := NewMemoryManager()
	release, acquired, err := m.AcquireLock(context.Background(), "job-1")
	if err != nil || !acquired {
		t.Fatalf("first AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	defer release()

	skip, acquired, err := m.AcquireLock(context.Background(), "job-1")
	if err != nil {
		t.Fatalf("second AcquireLock err = %v, want nil", err)
	}
	if acquired {
		t.Fatal("second AcquireLock acquired a held lock")
	}
	if skip == nil {
		t.Fatal("release is nil when the lock was not acquired")
	}

	// The not-acquired release is a no-op: it must not free the real holder.
	skip()
	skip()
	if _, acquired, _ := m.AcquireLock(context.Background(), "job-1"); acquired {
		t.Fatal("a not-acquired release freed the holder's lock")
	}
}

func TestMemoryManagerReacquireAfterRelease(t *testing.T) {
	m := NewMemoryManager()
	release, _, _ := m.AcquireLock(context.Background(), "job-1")
	release()

	release, acquired, err := m.AcquireLock(context.Background(), "job-1")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock after release = (%v, %v), want (true, nil)", acquired, err)
	}
	release()
}

func TestMemoryManagerKeysAreIndependent(t *testing.T) {
	m := NewMemoryManager()
	releaseA, acquiredA, _ := m.AcquireLock(context.Background(), "a")
	releaseB, acquiredB, _ := m.AcquireLock(context.Background(), "b")
	if !acquiredA || !acquiredB {
		t.Fatalf("acquired a=%v b=%v, want both true", acquiredA, acquiredB)
	}

	releaseA()
	if _, acquired, _ := m.AcquireLock(context.Background(), "b"); acquired {
		t.Fatal("releasing key a freed key b")
	}
	releaseB()
}

func TestMemoryManagerCancelDoesNotFreeTheLock(t *testing.T) {
	m := NewMemoryManager()
	ctx, cancel := context.WithCancel(context.Background())
	release, _, _ := m.AcquireLock(ctx, "job-1")
	cancel()

	if _, acquired, _ := m.AcquireLock(context.Background(), "job-1"); acquired {
		t.Fatal("cancelling the acquire context freed the lock")
	}
	release()
	if _, acquired, _ := m.AcquireLock(context.Background(), "job-1"); !acquired {
		t.Fatal("release did not free the lock")
	}
}

func TestMemoryManagerStaleReleaseKeepsLaterHolder(t *testing.T) {
	m := NewMemoryManager()
	releaseA, _, _ := m.AcquireLock(context.Background(), "job-1")
	releaseA()

	releaseB, acquired, _ := m.AcquireLock(context.Background(), "job-1")
	if !acquired {
		t.Fatal("B could not acquire after A released")
	}
	defer releaseB()

	releaseA() // stale: A no longer holds the lock.
	if _, acquired, _ := m.AcquireLock(context.Background(), "job-1"); acquired {
		t.Fatal("A's second release freed B's lock")
	}
}

func TestMemoryManagerConcurrentAcquireHasOneWinner(t *testing.T) {
	m := NewMemoryManager()
	const racers = 100

	var winners atomic.Int64
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, acquired, err := m.AcquireLock(context.Background(), "job-1")
			if err != nil {
				t.Errorf("AcquireLock err = %v, want nil", err)
			}
			if acquired {
				winners.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := winners.Load(); got != 1 {
		t.Fatalf("%d goroutines acquired the lock, want exactly 1", got)
	}
}

func TestNoopManager(t *testing.T) {
	m := NewNoopManager()
	const callers = 50

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, acquired, err := m.AcquireLock(context.Background(), "same-key")
			if err != nil || !acquired {
				t.Errorf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
			}
			if release == nil {
				t.Error("release is nil")
				return
			}
			release()
			release()
		}()
	}
	wg.Wait()

	// The zero value works too.
	if _, acquired, err := (NoopManager{}).AcquireLock(context.Background(), ""); err != nil || !acquired {
		t.Fatalf("zero NoopManager AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
}

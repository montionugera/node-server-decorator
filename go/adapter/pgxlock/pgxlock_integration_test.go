//go:build integration

package pgxlock

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests need a real PostgreSQL. Point PGXLOCK_TEST_DATABASE_URL at a
// throwaway instance; they create no tables and take only advisory locks.

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("PGXLOCK_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("PGXLOCK_TEST_DATABASE_URL is empty: set it to a throwaway PostgreSQL URL to run the integration tests")
	}
	return url
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func newPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return pool
}

// rawConn is a separate session, outside any pool the library uses.
func rawConn(t *testing.T, ctx context.Context) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatalf("pgx.Connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

// tryServiceLock runs the literal SQL joy-data-platform uses today. When it
// gets the lock it frees it again, so the probe leaves nothing held.
func tryServiceLock(t *testing.T, ctx context.Context, conn *pgx.Conn, literalKey string) bool {
	t.Helper()
	var got bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtext('job:' || '"+literalKey+"'))").Scan(&got); err != nil {
		t.Fatalf("service lock SQL: %v", err)
	}
	if got {
		if _, err := conn.Exec(ctx, "SELECT pg_advisory_unlock(hashtext('job:' || '"+literalKey+"'))"); err != nil {
			t.Fatalf("service unlock SQL: %v", err)
		}
	}
	return got
}

func wantAcquiredConns(t *testing.T, pool *pgxpool.Pool, want int32, when string) {
	t.Helper()
	if got := pool.Stat().AcquiredConns(); got != want {
		t.Fatalf("AcquiredConns %s = %d, want %d", when, got, want)
	}
}

func TestIntegrationHeldLockKeepsOneConnection(t *testing.T) {
	ctx := testContext(t)
	pool := newPool(t, ctx)
	m := New(pool)

	release, acquired, err := m.AcquireLock(ctx, "pool-accounting")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	wantAcquiredConns(t, pool, 1, "while the lock is held")

	// Same key, same Manager: a different connection, so not re-entrant.
	skip, acquired, err := m.AcquireLock(ctx, "pool-accounting")
	if err != nil || acquired {
		t.Fatalf("second AcquireLock = (%v, %v), want (false, nil)", acquired, err)
	}
	wantAcquiredConns(t, pool, 1, "after a not-acquired attempt")
	skip()

	release()
	wantAcquiredConns(t, pool, 0, "after release")
	release()
	wantAcquiredConns(t, pool, 0, "after a second release")
}

func TestIntegrationKeyMatchesServiceSQL(t *testing.T) {
	ctx := testContext(t)
	m := New(newPool(t, ctx))
	raw := rawConn(t, ctx)

	release, acquired, err := m.AcquireLock(ctx, "k")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	if tryServiceLock(t, ctx, raw, "k") {
		t.Fatal("the service's SQL took the lock while the library held key k: the lock identities differ")
	}

	release()
	if !tryServiceLock(t, ctx, raw, "k") {
		t.Fatal("the service's SQL could not take the lock after release")
	}
}

func TestIntegrationServiceHolderExcludesLibrary(t *testing.T) {
	ctx := testContext(t)
	pool := newPool(t, ctx)
	m := New(pool)
	raw := rawConn(t, ctx)

	// An old replica holds the lock through the service's literal SQL.
	var got bool
	if err := raw.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtext('job:' || 'rolling'))").Scan(&got); err != nil || !got {
		t.Fatalf("service lock = (%v, %v), want (true, nil)", got, err)
	}

	release, acquired, err := m.AcquireLock(ctx, "rolling")
	if err != nil || acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (false, nil)", acquired, err)
	}
	release()
	wantAcquiredConns(t, pool, 0, "after a not-acquired attempt")

	if _, err := raw.Exec(ctx, "SELECT pg_advisory_unlock(hashtext('job:' || 'rolling'))"); err != nil {
		t.Fatal(err)
	}
	release, acquired, err = m.AcquireLock(ctx, "rolling")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock after the service unlocked = (%v, %v), want (true, nil)", acquired, err)
	}
	release()
}

func TestIntegrationAnotherPoolCanLockAfterRelease(t *testing.T) {
	ctx := testContext(t)
	first := New(newPool(t, ctx))
	second := New(newPool(t, ctx))

	release, acquired, err := first.AcquireLock(ctx, "handover")
	if err != nil || !acquired {
		t.Fatalf("first AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	if _, acquired, err := second.AcquireLock(ctx, "handover"); err != nil || acquired {
		t.Fatalf("second pool AcquireLock while held = (%v, %v), want (false, nil)", acquired, err)
	}

	release()
	release2, acquired, err := second.AcquireLock(ctx, "handover")
	if err != nil || !acquired {
		t.Fatalf("second pool AcquireLock after release = (%v, %v), want (true, nil)", acquired, err)
	}
	release2()
}

func TestIntegrationCancelDoesNotFreeButReleaseDoes(t *testing.T) {
	ctx := testContext(t)
	pool := newPool(t, ctx)
	m := New(pool)
	raw := rawConn(t, ctx)

	callerCtx, cancel := context.WithCancel(ctx)
	release, acquired, err := m.AcquireLock(callerCtx, "cancelled")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	cancel()

	if tryServiceLock(t, ctx, raw, "cancelled") {
		t.Fatal("cancelling the caller context freed the lock")
	}
	wantAcquiredConns(t, pool, 1, "after the caller context was cancelled")

	release() // runs on its own context, not the cancelled one
	if !tryServiceLock(t, ctx, raw, "cancelled") {
		t.Fatal("release after cancel did not free the lock")
	}
	wantAcquiredConns(t, pool, 0, "after release")
}

func TestIntegrationCustomPrefixIsADifferentLock(t *testing.T) {
	ctx := testContext(t)
	m := New(newPool(t, ctx), WithKeyPrefix("cron:"))
	raw := rawConn(t, ctx)

	release, acquired, err := m.AcquireLock(ctx, "prefixed")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}
	defer release()

	if !tryServiceLock(t, ctx, raw, "prefixed") {
		t.Fatal("a cron: lock excluded the job: lock for the same key")
	}
}

func TestIntegrationFailedUnlockDropsTheConnection(t *testing.T) {
	ctx := testContext(t)
	pool := newPool(t, ctx)
	m := New(pool)
	raw := rawConn(t, ctx)

	release, acquired, err := m.AcquireLock(ctx, "broken-session")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
	}

	// Kill the session that holds the lock, so the unlock query fails.
	var killed int
	err = raw.QueryRow(ctx, `SELECT count(*) FROM (
		SELECT pg_terminate_backend(pid) FROM pg_locks
		WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
	) AS terminated`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminated %d lock-holding sessions (err %v), want 1", killed, err)
	}

	release() // unlock fails: the connection is closed, then handed back

	// The pool destroys a closed connection in the background, so its
	// counters settle a moment after release returns.
	deadline := time.Now().Add(5 * time.Second)
	for pool.Stat().TotalConns() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := pool.Stat().TotalConns(); got != 0 {
		t.Fatalf("TotalConns after a failed unlock = %d, want 0: the dead connection stayed in the pool", got)
	}
	wantAcquiredConns(t, pool, 0, "after a failed unlock")

	// The pool still works and the lock is free.
	release, acquired, err = m.AcquireLock(ctx, "broken-session")
	if err != nil || !acquired {
		t.Fatalf("AcquireLock after a failed unlock = (%v, %v), want (true, nil)", acquired, err)
	}
	release()
}

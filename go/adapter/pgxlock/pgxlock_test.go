package pgxlock

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// lockManager is a local copy of distlock.Manager from the root module. This
// module does not import the root module, so the method-set match is checked
// here against the exact signature.
type lockManager interface {
	AcquireLock(ctx context.Context, key string) (release func(), acquired bool, err error)
}

var _ lockManager = (*Manager)(nil)

// call records one query sent to a fake connection.
type call struct {
	sql         string
	args        []any
	ctxErr      error // ctx.Err() at call time
	hasDeadline bool
	deadline    time.Time
}

func recordCall(ctx context.Context, sql string, args []any) call {
	c := call{sql: sql, args: args, ctxErr: ctx.Err()}
	c.deadline, c.hasDeadline = ctx.Deadline()
	return c
}

type fakeRow struct {
	granted bool
	err     error
	panics  bool
}

func (r fakeRow) Scan(dest ...any) error {
	if r.panics {
		panic("fake scan panic")
	}
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*bool)) = r.granted
	return nil
}

// fakeConn is a scripted lockConn that logs every interaction in order.
type fakeConn struct {
	granted   bool
	lockErr   error
	execErr   error
	scanPanic bool // the lock query's Scan panics
	execPanic bool // the unlock query panics

	mu      sync.Mutex
	events  []string // "query", "exec", "close", "release" in call order
	queries []call
	execs   []call
	closes  []call
}

func (c *fakeConn) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "query")
	c.queries = append(c.queries, recordCall(ctx, sql, args))
	return fakeRow{granted: c.granted, err: c.lockErr, panics: c.scanPanic}
}

func (c *fakeConn) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "exec")
	c.execs = append(c.execs, recordCall(ctx, sql, args))
	if c.execPanic {
		panic("fake exec panic")
	}
	return pgconn.CommandTag{}, c.execErr
}

func (c *fakeConn) Close(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "close")
	c.closes = append(c.closes, recordCall(ctx, "", nil))
	return nil
}

func (c *fakeConn) Release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, "release")
}

func (c *fakeConn) log() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.events...)
}

// fakePool hands out one scripted connection, or fails the lease.
type fakePool struct {
	conn  *fakeConn
	err   error
	block bool // wait for ctx to end, then return its error (an exhausted pool)

	leases []call
}

func (p *fakePool) Acquire(ctx context.Context) (lockConn, error) {
	p.leases = append(p.leases, recordCall(ctx, "", nil))
	if p.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if p.err != nil {
		return nil, p.err
	}
	return p.conn, nil
}

// newTestManager builds a Manager on a fake pool through the same option path
// New uses.
func newTestManager(p *fakePool, opts ...Option) *Manager {
	m := New(nil, opts...)
	m.pool = p
	return m
}

// wantDeadlineIn checks the call ran with a deadline of start+d, where start
// lies between before and now.
func wantDeadlineIn(t *testing.T, c call, before time.Time, d time.Duration, what string) {
	t.Helper()
	if !c.hasDeadline || c.deadline.Before(before.Add(d)) || c.deadline.After(time.Now().Add(d)) {
		t.Fatalf("%s deadline %v (set %v) is not the %v timeout", what, c.deadline, c.hasDeadline, d)
	}
}

func wantEvents(t *testing.T, c *fakeConn, want ...string) {
	t.Helper()
	if got := c.log(); !reflect.DeepEqual(got, want) {
		t.Fatalf("connection events = %v, want %v", got, want)
	}
}

func TestNilPoolReturnsErrNilPool(t *testing.T) {
	m := New(nil)
	release, acquired, err := m.AcquireLock(context.Background(), "k")
	if !errors.Is(err, ErrNilPool) {
		t.Fatalf("err = %v, want ErrNilPool", err)
	}
	if acquired {
		t.Fatal("acquired = true with a nil pool")
	}
	if release == nil {
		t.Fatal("release is nil")
	}
	release()
}

func TestNewWiresTheRealPool(t *testing.T) {
	pool := &pgxpool.Pool{} // never called: only the wiring is checked
	m := New(pool)
	if got, ok := m.pool.(poolAdapter); !ok || got.pool != pool {
		t.Fatalf("m.pool = %#v, want poolAdapter on the given pool", m.pool)
	}
}

func TestDefaultsAndOptions(t *testing.T) {
	m := New(nil)
	if m.prefix != "job:" || m.acquireTimeout != 5*time.Second || m.unlockTimeout != 5*time.Second {
		t.Fatalf("defaults = (%q, %v, %v), want (\"job:\", 5s, 5s)", m.prefix, m.acquireTimeout, m.unlockTimeout)
	}

	m = New(nil, WithKeyPrefix("cron:"), WithAcquireTimeout(time.Second), WithUnlockTimeout(2*time.Second))
	if m.prefix != "cron:" || m.acquireTimeout != time.Second || m.unlockTimeout != 2*time.Second {
		t.Fatalf("options = (%q, %v, %v), want (\"cron:\", 1s, 2s)", m.prefix, m.acquireTimeout, m.unlockTimeout)
	}
}

func TestNonPositiveTimeoutsKeepTheDefault(t *testing.T) {
	for _, d := range []time.Duration{0, -time.Second} {
		m := New(nil, WithAcquireTimeout(d), WithUnlockTimeout(d))
		if m.acquireTimeout != 5*time.Second || m.unlockTimeout != 5*time.Second {
			t.Fatalf("timeouts after %v = (%v, %v), want the 5s defaults", d, m.acquireTimeout, m.unlockTimeout)
		}
	}
}

func TestAcquireSendsExactSQLWithPrefixedKey(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts []Option
		want string
	}{
		{name: "default prefix", want: "job:nightly"},
		{name: "custom prefix", opts: []Option{WithKeyPrefix("cron:")}, want: "cron:nightly"},
		{name: "empty prefix", opts: []Option{WithKeyPrefix("")}, want: "nightly"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := &fakeConn{granted: true}
			m := newTestManager(&fakePool{conn: conn}, tc.opts...)

			release, acquired, err := m.AcquireLock(context.Background(), "nightly")
			if err != nil || !acquired {
				t.Fatalf("AcquireLock = (%v, %v), want (true, nil)", acquired, err)
			}
			wantEvents(t, conn, "query") // held: the connection stays leased

			q := conn.queries[0]
			if q.sql != "SELECT pg_try_advisory_lock(hashtext($1))" {
				t.Fatalf("lock SQL = %q", q.sql)
			}
			if !reflect.DeepEqual(q.args, []any{tc.want}) {
				t.Fatalf("lock args = %v, want [%q]", q.args, tc.want)
			}

			release()
			e := conn.execs[0]
			if e.sql != "SELECT pg_advisory_unlock(hashtext($1))" {
				t.Fatalf("unlock SQL = %q", e.sql)
			}
			if !reflect.DeepEqual(e.args, []any{tc.want}) {
				t.Fatalf("unlock args = %v, want [%q]", e.args, tc.want)
			}
			wantEvents(t, conn, "query", "exec", "release")
		})
	}
}

func TestAcquireTimeoutCoversLeaseAndQuery(t *testing.T) {
	conn := &fakeConn{granted: true}
	pool := &fakePool{conn: conn}
	m := newTestManager(pool, WithAcquireTimeout(time.Minute))

	before := time.Now()
	release, _, err := m.AcquireLock(context.Background(), "k")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	lease, query := pool.leases[0], conn.queries[0]
	if !lease.hasDeadline || !query.hasDeadline {
		t.Fatalf("deadline set: lease=%v query=%v, want both", lease.hasDeadline, query.hasDeadline)
	}
	if !lease.deadline.Equal(query.deadline) {
		t.Fatalf("lease deadline %v != query deadline %v: not one shared timeout", lease.deadline, query.deadline)
	}
	if lease.deadline.Before(before.Add(time.Minute)) || lease.deadline.After(time.Now().Add(time.Minute)) {
		t.Fatalf("deadline %v is not the 1m acquire timeout", lease.deadline)
	}
}

func TestCallerDeadlineAndCancelStillWin(t *testing.T) {
	t.Run("earlier caller deadline", func(t *testing.T) {
		pool := &fakePool{conn: &fakeConn{granted: true}}
		m := newTestManager(pool, WithAcquireTimeout(time.Hour))

		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		release, _, _ := m.AcquireLock(ctx, "k")
		defer release()

		want, _ := ctx.Deadline()
		if got := pool.leases[0].deadline; !got.Equal(want) {
			t.Fatalf("lease deadline = %v, want the caller's %v", got, want)
		}
	})

	t.Run("cancelled caller", func(t *testing.T) {
		conn := &fakeConn{granted: true}
		pool := &fakePool{conn: conn}
		m := newTestManager(pool)

		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		release, _, _ := m.AcquireLock(ctx, "k")
		defer release()

		if !errors.Is(pool.leases[0].ctxErr, context.Canceled) {
			t.Fatalf("lease ctx err = %v, want context.Canceled", pool.leases[0].ctxErr)
		}
		if !errors.Is(conn.queries[0].ctxErr, context.Canceled) {
			t.Fatalf("lock query ctx err = %v, want context.Canceled", conn.queries[0].ctxErr)
		}
	})
}

func TestLeaseFailureIsWrapped(t *testing.T) {
	errPool := errors.New("pool closed")
	m := newTestManager(&fakePool{err: errPool})

	release, acquired, err := m.AcquireLock(context.Background(), "k")
	if acquired {
		t.Fatal("acquired = true after a failed lease")
	}
	if !errors.Is(err, errPool) || err == errPool {
		t.Fatalf("err = %v, want a wrap of %v", err, errPool)
	}
	release()
}

func TestExhaustedPoolReportsDeadlineExceeded(t *testing.T) {
	m := newTestManager(&fakePool{block: true}, WithAcquireTimeout(20*time.Millisecond))

	release, acquired, err := m.AcquireLock(context.Background(), "k")
	if acquired {
		t.Fatal("acquired = true on an exhausted pool")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
	release()
}

func TestNotAcquiredReturnsConnectionAtOnce(t *testing.T) {
	conn := &fakeConn{granted: false}
	m := newTestManager(&fakePool{conn: conn})

	release, acquired, err := m.AcquireLock(context.Background(), "k")
	if err != nil || acquired {
		t.Fatalf("AcquireLock = (%v, %v), want (false, nil)", acquired, err)
	}
	wantEvents(t, conn, "query", "release")

	// The not-acquired release is a no-op: no unlock, no second Release.
	release()
	release()
	wantEvents(t, conn, "query", "release")
}

func TestLockQueryErrorClosesConnection(t *testing.T) {
	errQuery := errors.New("connection reset by peer")
	conn := &fakeConn{lockErr: errQuery}
	m := newTestManager(&fakePool{conn: conn}, WithUnlockTimeout(time.Minute))

	// The acquire context is already dead, as it is after a query timeout.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := time.Now()
	release, acquired, err := m.AcquireLock(ctx, "k")
	if acquired {
		t.Fatal("acquired = true after a lock query error")
	}
	if !errors.Is(err, errQuery) {
		t.Fatalf("err = %v, want a wrap of %v", err, errQuery)
	}
	// Closed first, so the pool destroys it on Release instead of reusing a
	// session that may hold the lock.
	wantEvents(t, conn, "query", "close", "release")

	closed := conn.closes[0]
	if closed.ctxErr != nil {
		t.Fatalf("Close ran on a dead context: %v", closed.ctxErr)
	}
	wantDeadlineIn(t, closed, before, time.Minute, "Close")

	release()
	wantEvents(t, conn, "query", "close", "release")
}

func TestReleaseIgnoresCallerContext(t *testing.T) {
	conn := &fakeConn{granted: true}
	m := newTestManager(&fakePool{conn: conn}, WithUnlockTimeout(time.Minute))

	ctx, cancel := context.WithCancel(context.Background())
	release, _, err := m.AcquireLock(ctx, "k")
	if err != nil {
		t.Fatal(err)
	}
	cancel() // a deferred release usually runs after the caller's ctx ended

	wantEvents(t, conn, "query") // cancelling did not free the lock
	before := time.Now()
	release()

	unlock := conn.execs[0]
	if unlock.ctxErr != nil {
		t.Fatalf("unlock ran on a dead context: %v", unlock.ctxErr)
	}
	wantDeadlineIn(t, unlock, before, time.Minute, "unlock")
}

func TestReleaseTwiceReturnsConnectionOnce(t *testing.T) {
	conn := &fakeConn{granted: true}
	m := newTestManager(&fakePool{conn: conn})

	release, _, _ := m.AcquireLock(context.Background(), "k")

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

	wantEvents(t, conn, "query", "exec", "release")
}

func TestUnlockErrorClosesConnectionBeforeRelease(t *testing.T) {
	conn := &fakeConn{granted: true, execErr: errors.New("broken pipe")}
	m := newTestManager(&fakePool{conn: conn}, WithUnlockTimeout(time.Minute))

	release, _, _ := m.AcquireLock(context.Background(), "k")
	before := time.Now()
	release() // returns nothing: the unlock error is swallowed
	release()

	wantEvents(t, conn, "query", "exec", "close", "release")
	closed := conn.closes[0]
	if closed.ctxErr != nil {
		t.Fatalf("Close ran on a dead context: %v", closed.ctxErr)
	}
	wantDeadlineIn(t, closed, before, time.Minute, "Close")
}

func TestPanicInLockQueryStillDropsTheConnection(t *testing.T) {
	conn := &fakeConn{scanPanic: true}
	m := newTestManager(&fakePool{conn: conn})

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the panic was swallowed")
			}
		}()
		_, _, _ = m.AcquireLock(context.Background(), "k")
	}()
	wantEvents(t, conn, "query", "close", "release")
}

func TestPanicInUnlockStillDropsTheConnection(t *testing.T) {
	conn := &fakeConn{granted: true, execPanic: true}
	m := newTestManager(&fakePool{conn: conn})
	release, _, _ := m.AcquireLock(context.Background(), "k")

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the panic was swallowed")
			}
		}()
		release()
	}()
	wantEvents(t, conn, "query", "exec", "close", "release")
}

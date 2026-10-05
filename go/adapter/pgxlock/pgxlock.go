package pgxlock

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	lockSQL   = "SELECT pg_try_advisory_lock(hashtext($1))"
	unlockSQL = "SELECT pg_advisory_unlock(hashtext($1))"

	defaultKeyPrefix = "job:"
	defaultTimeout   = 5 * time.Second
)

// ErrNilPool is returned by AcquireLock when New was given a nil pool.
var ErrNilPool = errors.New("pgxlock: pool is nil")

// lockConn is the part of a leased pool connection the Manager uses.
type lockConn interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	// Release hands the connection back to the pool. The pool destroys it
	// instead of reusing it when it was closed first.
	Release()
	// Close ends the database session.
	Close(ctx context.Context) error
}

// leaser leases one dedicated connection.
type leaser interface {
	Acquire(ctx context.Context) (lockConn, error)
}

// poolAdapter and connAdapter bind the seam to pgxpool. They only delegate.
type poolAdapter struct{ pool *pgxpool.Pool }

func (p poolAdapter) Acquire(ctx context.Context) (lockConn, error) {
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	return connAdapter{conn}, nil
}

type connAdapter struct{ conn *pgxpool.Conn }

func (c connAdapter) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return c.conn.QueryRow(ctx, sql, args...)
}

func (c connAdapter) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return c.conn.Exec(ctx, sql, args...)
}

func (c connAdapter) Release() { c.conn.Release() }

func (c connAdapter) Close(ctx context.Context) error { return c.conn.Conn().Close(ctx) }

// Manager takes a session-scoped Postgres advisory lock on a leased pool connection.
type Manager struct {
	pool           leaser // nil when New was given a nil pool
	prefix         string
	acquireTimeout time.Duration
	unlockTimeout  time.Duration
}

// Option configures a Manager.
type Option func(*Manager)

// New builds a Manager on pool. A nil pool is allowed: AcquireLock then returns an error.
func New(pool *pgxpool.Pool, opts ...Option) *Manager {
	m := &Manager{
		prefix:         defaultKeyPrefix,
		acquireTimeout: defaultTimeout,
		unlockTimeout:  defaultTimeout,
	}
	if pool != nil {
		m.pool = poolAdapter{pool}
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// WithKeyPrefix sets the text put before the key before hashing. Default "job:".
func WithKeyPrefix(prefix string) Option {
	return func(m *Manager) { m.prefix = prefix }
}

// WithAcquireTimeout bounds leasing the connection plus the lock query. Default 5s.
// A zero or negative d is ignored.
func WithAcquireTimeout(d time.Duration) Option {
	return func(m *Manager) {
		if d > 0 {
			m.acquireTimeout = d
		}
	}
}

// WithUnlockTimeout bounds the unlock query. Default 5s.
// A zero or negative d is ignored.
//
// The same bound applies to closing a connection after a failed lock or
// unlock query, so a failing AcquireLock can take up to the acquire timeout
// plus this one.
func WithUnlockTimeout(d time.Duration) Option {
	return func(m *Manager) {
		if d > 0 {
			m.unlockTimeout = d
		}
	}
}

func noopRelease() {}

// AcquireLock tries to take the advisory lock for key without waiting.
//
// acquired is false, with a nil error, when another session holds the lock.
// release is never nil; it unlocks and returns the leased connection, is
// idempotent and is safe to defer. Cancelling ctx after a successful acquire
// does not free the lock.
func (m *Manager) AcquireLock(ctx context.Context, key string) (release func(), acquired bool, err error) {
	if m.pool == nil {
		return noopRelease, false, ErrNilPool
	}

	// One timeout covers the lease and the lock query. It derives from ctx, so
	// an earlier caller deadline or cancel still wins.
	acquireCtx, cancel := context.WithTimeout(ctx, m.acquireTimeout)
	defer cancel()

	conn, err := m.pool.Acquire(acquireCtx)
	if err != nil {
		return noopRelease, false, fmt.Errorf("pgxlock: lease connection: %w", err)
	}

	// Until the outcome is known the lock may be held: on an error (the reply
	// can be lost after the grant) or a panic, ending the session is the only
	// sure way not to leave it held on an idle pooled connection.
	settled := false
	defer func() {
		if !settled {
			m.closeAndRelease(conn)
		}
	}()

	name := m.prefix + key
	if err := conn.QueryRow(acquireCtx, lockSQL, name).Scan(&acquired); err != nil {
		return noopRelease, false, fmt.Errorf("pgxlock: lock query: %w", err)
	}
	settled = true
	if !acquired {
		conn.Release()
		return noopRelease, false, nil
	}

	var once sync.Once
	return func() { once.Do(func() { m.unlock(conn, name) }) }, true, nil
}

// unlock frees the lock and returns the connection. It runs on its own
// context: the caller's is often already cancelled when a deferred release runs.
//
// If the unlock query fails or panics, the session is ended instead, so the
// lock cannot stay held on an idle pooled connection.
func (m *Manager) unlock(conn lockConn, name string) {
	unlocked := false
	defer func() {
		if !unlocked {
			m.closeAndRelease(conn)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), m.unlockTimeout)
	defer cancel()
	if _, err := conn.Exec(ctx, unlockSQL, name); err != nil {
		return
	}
	unlocked = true
	conn.Release()
}

// closeAndRelease ends the session, then hands the connection back so the
// pool frees its slot and destroys the closed connection.
func (m *Manager) closeAndRelease(conn lockConn) {
	ctx, cancel := context.WithTimeout(context.Background(), m.unlockTimeout)
	defer cancel()
	_ = conn.Close(ctx)
	conn.Release()
}

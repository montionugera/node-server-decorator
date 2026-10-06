// Package pgxlock is a try-or-skip lock manager backed by PostgreSQL session
// advisory locks, for pgx v5 pools.
//
// A Manager never waits for a held lock: AcquireLock returns at once with
// acquired == false when another session has it. Its method set matches
// distlock.Manager from go/core/distlock in the root module, so a *Manager can
// be passed wherever that interface is expected. This module does not import
// the root module.
//
// Things to know before using it:
//
//   - One pool connection per held lock. A session advisory lock belongs to
//     one connection, so AcquireLock leases a dedicated connection and keeps
//     it out of the pool until release is called. Size the pool with one
//     spare connection for every lock that can be held at the same time.
//   - Lock identity. The lock is pg_try_advisory_lock(hashtext(prefix + key)).
//     With the default prefix "job:" it is the same lock as
//     pg_try_advisory_lock(hashtext('job:' || key)), so old and new replicas
//     exclude each other during a rolling deploy.
//   - Hash collisions. hashtext returns a 32-bit integer. Two different keys
//     can hash to the same value and then exclude each other.
//   - A failed unlock closes the connection. If the unlock query returns an
//     error, release closes the connection before handing it back, so the
//     pool destroys it. Ending the session makes PostgreSQL free the lock; an
//     idle pooled connection would otherwise keep it. The same is done when
//     the lock query itself fails, because the lock may have been granted.
package pgxlock

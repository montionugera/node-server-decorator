package distlock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	mathrand "math/rand"
	"sync"
	"time"
)

var (
	// ErrLockNotAcquired is returned when a lock cannot be acquired within wait timeout.
	ErrLockNotAcquired = errors.New("distlock: failed to acquire lock within timeout")
	// ErrLockLost is returned when lock renewal fails or is lost.
	ErrLockLost = errors.New("distlock: lock lease expired or was taken by another instance")
)

const (
	// ReleaseLockLua atomically releases the lock only if the token matches.
	ReleaseLockLua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
	// RenewLockLua atomically extends the lock TTL only if the token matches.
	RenewLockLua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`
)

// RedisClient defines the dependency-free interface required for distributed locking.
type RedisClient interface {
	SetNX(ctx context.Context, key string, value string, ttl time.Duration) (bool, error)
	Eval(ctx context.Context, script string, keys []string, args ...any) (any, error)
}

// Config configures a Locker instance.
type Config struct {
	Client        RedisClient
	DefaultTTL    time.Duration
	AutoRenew     bool
	RetryInterval time.Duration
}

// Locker manages distributed locks backed by a RedisClient.
type Locker struct {
	cfg Config
}

// New creates a new Locker instance.
func New(cfg Config) *Locker {
	if cfg.DefaultTTL <= 0 {
		cfg.DefaultTTL = 10 * time.Second
	}
	if cfg.RetryInterval <= 0 {
		cfg.RetryInterval = 100 * time.Millisecond
	}
	return &Locker{cfg: cfg}
}

// Lock represents an active distributed lock hold.
type Lock interface {
	Key() string
	Token() string
	Release(ctx context.Context) error
}

type lockImpl struct {
	locker      *Locker
	key         string
	token       string
	stopWatchdog func()
	once        sync.Once
	released    bool
	mu          sync.Mutex
}

func (l *lockImpl) Key() string {
	return l.key
}

func (l *lockImpl) Token() string {
	return l.token
}

func (l *lockImpl) Release(ctx context.Context) error {
	var err error
	l.once.Do(func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.released = true

		if l.stopWatchdog != nil {
			l.stopWatchdog()
		}

		_, err = l.locker.cfg.Client.Eval(ctx, ReleaseLockLua, []string{l.key}, l.token)
	})
	return err
}

type acquireOptions struct {
	ttl           time.Duration
	waitTimeout   time.Duration
	retryInterval time.Duration
	autoRenew     bool
}

// Option modifies lock acquisition behavior.
type Option func(*acquireOptions)

// WithTTL overrides the default lock lease duration.
func WithTTL(ttl time.Duration) Option {
	return func(o *acquireOptions) {
		o.ttl = ttl
	}
}

// WithWaitTimeout sets the maximum duration to wait/retry acquiring the lock.
func WithWaitTimeout(timeout time.Duration) Option {
	return func(o *acquireOptions) {
		o.waitTimeout = timeout
	}
}

// WithRetryInterval sets the base sleep duration between retries.
func WithRetryInterval(interval time.Duration) Option {
	return func(o *acquireOptions) {
		o.retryInterval = interval
	}
}

// WithAutoRenew enables or disables background heartbeat watchdog renewal.
func WithAutoRenew(autoRenew bool) Option {
	return func(o *acquireOptions) {
		o.autoRenew = autoRenew
	}
}

func generateToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Acquire attempts to acquire a distributed lock.
func (l *Locker) Acquire(ctx context.Context, key string, opts ...Option) (Lock, error) {
	if l.cfg.Client == nil {
		return nil, errors.New("distlock: RedisClient must not be nil")
	}

	opt := acquireOptions{
		ttl:           l.cfg.DefaultTTL,
		waitTimeout:   0,
		retryInterval: l.cfg.RetryInterval,
		autoRenew:     l.cfg.AutoRenew,
	}
	for _, o := range opts {
		o(&opt)
	}

	token := generateToken()
	startTime := time.Now()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		ok, err := l.cfg.Client.SetNX(ctx, key, token, opt.ttl)
		if err != nil {
			return nil, fmt.Errorf("distlock: SetNX failed: %w", err)
		}
		if ok {
			break
		}

		elapsed := time.Since(startTime)
		if elapsed >= opt.waitTimeout {
			return nil, ErrLockNotAcquired
		}

		// Randomized jitter ±20%
		jitter := time.Duration(float64(opt.retryInterval) * (mathrand.Float64()*0.4 - 0.2))
		sleepDur := opt.retryInterval + jitter
		if sleepDur < 5*time.Millisecond {
			sleepDur = 5 * time.Millisecond
		}
		if remain := opt.waitTimeout - elapsed; sleepDur > remain {
			sleepDur = remain
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(sleepDur):
		}
	}

	lock := &lockImpl{
		locker: l,
		key:    key,
		token:  token,
	}

	if opt.autoRenew {
		watchdogCtx, cancel := context.WithCancel(context.Background())
		lock.stopWatchdog = cancel

		go func() {
			period := opt.ttl / 3
			if period < 10*time.Millisecond {
				period = 10 * time.Millisecond
			}
			ticker := time.NewTicker(period)
			defer ticker.Stop()

			ttlMs := opt.ttl.Milliseconds()

			for {
				select {
				case <-watchdogCtx.Done():
					return
				case <-ticker.C:
					res, err := l.cfg.Client.Eval(watchdogCtx, RenewLockLua, []string{key}, token, ttlMs)
					if err != nil {
						return
					}
					// If renewal returns 0 (lock expired or taken by another instance)
					if num, ok := res.(int64); ok && num == 0 {
						return
					}
				}
			}
		}()
	}

	return lock, nil
}

// Do executes fn inside an acquired distributed lock, automatically releasing on return.
func (l *Locker) Do(ctx context.Context, key string, fn func(ctx context.Context) error, opts ...Option) error {
	lock, err := l.Acquire(ctx, key, opts...)
	if err != nil {
		return err
	}
	defer lock.Release(context.Background())

	return fn(ctx)
}

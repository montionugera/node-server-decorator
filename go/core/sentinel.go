package core

import "errors"

type cacheMissSentinel struct{}

func (c *cacheMissSentinel) String() string {
	return "CACHE_MISS"
}

// CacheMiss is the sentinel pointer value indicating that a key was absent from the cache.
// Corresponds to Symbol.for('server-decorator.cache.miss') in TypeScript and
// CACHE_MISS = object() in Python (contracts/rules/cache-adapter.md).
var CacheMiss = &cacheMissSentinel{}

// ErrCacheMiss is the standard sentinel error returned by CacheAdapter.Get when a key is absent.
var ErrCacheMiss = errors.New("cache: key not found")

package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// CacheAdapter defines the interface required by the Cache generic wrapper.
// Absences must be indicated either by returning ErrCacheMiss as the error
// or CacheMiss as the value.
type CacheAdapter interface {
	Get(ctx context.Context, key string) (any, error)
	Set(ctx context.Context, key string, val any, ttl time.Duration) error
}

// CacheKeyArgsProvider allows complex input types to explicitly supply
// args and kwargs for cache key generation.
type CacheKeyArgsProvider interface {
	CacheKeyArgs() ([]any, map[string]any)
}

// Cache wraps a function with caching behavior using the provided CacheAdapter.
// Cache hits return the cached Out value without calling fn.
// Cache misses (indicated by ErrCacheMiss or CacheMiss) call fn and write the result to adapter.
// Valid nil / zero values stored in the cache are treated as hits and returned without re-evaluating fn.
func Cache[In, Out any](
	adapter CacheAdapter,
	qualname string,
	ttl time.Duration,
	fn func(context.Context, In) (Out, error),
) func(context.Context, In) (Out, error) {
	return func(ctx context.Context, in In) (Out, error) {
		var zero Out

		var args []any
		var kwargs map[string]any

		if provider, ok := any(in).(CacheKeyArgsProvider); ok {
			args, kwargs = provider.CacheKeyArgs()
		} else if a, ok := any(in).([]any); ok {
			args = a
		} else if _, ok := any(in).(struct{}); ok {
			args = []any{}
		} else {
			args = []any{in}
		}

		key := BuildCacheKey(qualname, args, kwargs)

		cached, err := adapter.Get(ctx, key)
		if errors.Is(err, ErrCacheMiss) || cached == CacheMiss {
			result, err := fn(ctx, in)
			if err != nil {
				return zero, err
			}
			_ = adapter.Set(ctx, key, result, ttl)
			return result, nil
		}
		if err != nil {
			return zero, err
		}

		if cached == nil {
			return zero, nil
		}

		if out, ok := cached.(Out); ok {
			return out, nil
		}

		// Attempt JSON unmarshal fallback if cached representation was serialized
		data, err := json.Marshal(cached)
		if err == nil {
			var out Out
			if err := json.Unmarshal(data, &out); err == nil {
				return out, nil
			}
		}

		return zero, fmt.Errorf("cache: cannot cast cached value of type %T to %T", cached, zero)
	}
}

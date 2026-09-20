package gqlloader

import (
	"context"
	"sync"

	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

type contextKey struct{}

var registryContextKey = contextKey{}

// Registry manages request-scoped Loader instances for GraphQL resolvers.
type Registry struct {
	mu      sync.Mutex
	loaders map[string]any
}

// NewRegistry creates a new GraphQL request-scoped loader registry.
func NewRegistry() *Registry {
	return &Registry{
		loaders: make(map[string]any),
	}
}

// GetOrCreate returns an existing loader or registers a newly created one under the given name.
func GetOrCreate[K comparable, V any](r *Registry, name string, factory func() *coalesce.Loader[K, V]) *coalesce.Loader[K, V] {
	r.mu.Lock()
	defer r.mu.Unlock()

	if val, ok := r.loaders[name]; ok {
		if loader, ok := val.(*coalesce.Loader[K, V]); ok {
			return loader
		}
	}

	loader := factory()
	r.loaders[name] = loader
	return loader
}

// WithContext attaches a request-scoped loader registry to context.Context.
func WithContext(ctx context.Context, r *Registry) context.Context {
	return context.WithValue(ctx, registryContextKey, r)
}

// ForContext retrieves the request-scoped Registry from context.Context, or returns nil if none attached.
func ForContext(ctx context.Context) *Registry {
	if ctx == nil {
		return nil
	}
	r, _ := ctx.Value(registryContextKey).(*Registry)
	return r
}

// Load loads a single key using a request-scoped Loader from context, falling back to a standalone Loader if no registry in context.
func Load[K comparable, V any](
	ctx context.Context,
	name string,
	key K,
	cfg coalesce.Config[K, V],
) (V, error) {
	reg := ForContext(ctx)
	if reg != nil {
		loader := GetOrCreate(reg, name, func() *coalesce.Loader[K, V] {
			return coalesce.New(cfg)
		})
		return loader.Load(ctx, key)
	}

	// Fallback without request registry
	loader := coalesce.New(cfg)
	return loader.Load(ctx, key)
}

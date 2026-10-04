import { AsyncLocalStorage } from 'async_hooks';

export interface GraphQLLoaderOptions<TParent = any, TKey = any, TResult = any> {
  /**
   * Extractor function to obtain the lookup key (or array of keys) from the GraphQL resolver parent object.
   */
  key: (parent: TParent) => TKey | TKey[] | null | undefined;
  /**
   * Service instance or class containing the loader method.
   */
  service?: any;
  /**
   * Name of the method on the service to call for batch loading.
   */
  method?: string;
  /**
   * Directly supplied loader function (accepting a key or array of keys).
   */
  loader?: (key: TKey) => Promise<TResult>;
  /**
   * If true, unpacks array keys by calling loader on each key and returning Promise.all(results).
   */
  isList?: boolean;
}

export class GraphQLLoaderRegistry {
  private loaders = new Map<string, any>();
  private disposers: Array<() => void | Promise<void>> = [];

  /**
   * Get or instantiate a loader instance registered under a specific cache key for this request.
   */
  getOrCreate<T>(name: string, factory: () => T): T {
    if (!this.loaders.has(name)) {
      const instance = factory();
      this.loaders.set(name, instance);
    }
    return this.loaders.get(name);
  }

  /**
   * Register a cleanup hook to be called when the GraphQL request completes.
   */
  onDispose(disposer: () => void | Promise<void>): void {
    this.disposers.push(disposer);
  }

  /**
   * Dispose all loaders and release resources associated with this request.
   */
  async dispose(): Promise<void> {
    for (const disposer of this.disposers) {
      try {
        await disposer();
      } catch {
        // ignore errors during cleanup
      }
    }
    this.loaders.clear();
    this.disposers = [];
  }
}

export const graphQLLoaderStorage = new AsyncLocalStorage<GraphQLLoaderRegistry>();

/**
 * Creates an isolated request-scoped loader registry context.
 * Can be merged directly into GraphQL context ({ ...createGraphQLLoaderContext() }).
 */
export function createGraphQLLoaderContext(): {
  loaders: GraphQLLoaderRegistry;
  cleanupLoaders: () => Promise<void>;
} {
  const registry = new GraphQLLoaderRegistry();
  return {
    loaders: registry,
    cleanupLoaders: () => registry.dispose(),
  };
}

/**
 * Higher-order function / decorator that wraps a GraphQL field resolver with DataLoader batching.
 * Compatible with Apollo Server, Mercurius, and GraphQL Yoga.
 */
export function graphqlLoader<TParent = any, TKey = any, TResult = any>(
  options: GraphQLLoaderOptions<TParent, TKey, TResult>
) {
  const { key: keyExtractor, service, method, loader, isList } = options;

  return async function graphqlFieldResolver(
    parent: TParent,
    args: any,
    context: any,
    info: any
  ): Promise<TResult | TResult[] | null | undefined> {
    if (parent == null) {
      return null;
    }

    const key = keyExtractor(parent);
    if (key == null) {
      return null;
    }

    // Resolve request-scoped registry from context or AsyncLocalStorage
    let registry: GraphQLLoaderRegistry | undefined;
    if (context && context.loaders instanceof GraphQLLoaderRegistry) {
      registry = context.loaders;
    } else {
      registry = graphQLLoaderStorage.getStore();
    }

    // Determine the load function
    let loadFn: ((k: TKey) => Promise<TResult>) | undefined;

    if (loader) {
      loadFn = loader;
    } else if (service && method) {
      const targetInstance = typeof service === 'function' && !(service.prototype && service.prototype[method])
        ? service()
        : service;

      // If the service is a class or factory, check if registry has a request-scoped instance
      if (registry) {
        const cacheKey = `${targetInstance.constructor?.name || 'Service'}.${method}`;
        loadFn = registry.getOrCreate(cacheKey, () => {
          const fn = targetInstance[method];
          if (typeof fn !== 'function') {
            throw new Error(`Method '${method}' not found on service ${targetInstance.constructor?.name}`);
          }
          return fn.bind(targetInstance);
        });
      } else {
        const fn = targetInstance[method];
        if (typeof fn !== 'function') {
          throw new Error(`Method '${method}' not found on service ${targetInstance.constructor?.name}`);
        }
        loadFn = fn.bind(targetInstance);
      }
    }

    if (!loadFn) {
      throw new Error('graphqlLoader requires either `loader` function or `service` and `method`');
    }

    if (Array.isArray(key)) {
      if (key.length === 0) {
        return [] as any;
      }
      return Promise.all(key.map((k) => loadFn!(k))) as Promise<any>;
    }

    if (isList) {
      const res = await loadFn(key);
      return Array.isArray(res) ? res : [res];
    }

    return loadFn(key);
  };
}

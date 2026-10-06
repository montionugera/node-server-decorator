import { AsyncLocalStorage } from 'async_hooks';
import { batchLoadScopeStorage, type BatchLoadScope } from '../decorators/batch-load';

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

export class GraphQLLoaderRegistry implements BatchLoadScope {
  private loaders = new Map<string, any>();
  private scopes = new Map<any, object>();
  private services = new Map<any, any>();

  /**
   * Batching scope token for a service instance, unique to this registry. `@batchLoad` keys its
   * queue and L1 cache by this token, so neither is shared with another request nor outlives dispose().
   */
  scopeFor(identity: object): object {
    let scope = this.scopes.get(identity);
    if (!scope) {
      scope = {};
      this.scopes.set(identity, scope);
    }
    return scope;
  }

  /**
   * Get or build the service instance for a `service` option, keyed by identity (never by name).
   */
  serviceFor<T>(source: any, factory: () => T): T {
    if (!this.services.has(source)) {
      this.services.set(source, factory());
    }
    return this.services.get(source);
  }
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
    this.scopes.clear();
    this.services.clear();
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

  const missingMethod = (target: any) =>
    new Error(`Method '${method}' not found on service ${target?.constructor?.name}`);

  // A pre-built instance (or anything already exposing the method) is used as-is; a class whose
  // prototype has the method is instantiated; any other function is a factory.
  const isClass = typeof service === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(service));
  const isInstance = !service || !method || typeof service !== 'function' || typeof service[method] === 'function';
  const buildService = (): any => {
    if (isInstance) return service;
    if (isClass) return new service();
    return typeof service.prototype?.[method!] === 'function' ? new service() : service();
  };
  if (!loader && service && method && isInstance && typeof service[method] !== 'function') {
    throw missingMethod(service);
  }
  if (!loader && service && method && isClass && !isInstance && typeof service.prototype?.[method] !== 'function') {
    throw new Error(`Method '${method}' not found on service ${service.name}`);
  }

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
      // One instance per request for classes/factories; without a registry nothing is shared.
      const targetInstance = registry ? registry.serviceFor(service, buildService) : buildService();
      const fn = targetInstance?.[method];
      if (typeof fn !== 'function') {
        throw missingMethod(targetInstance);
      }
      loadFn = fn.bind(targetInstance);
    }

    if (!loadFn) {
      throw new Error('graphqlLoader requires either `loader` function or `service` and `method`');
    }

    // Batch queues and L1 caches are owned by the request registry. Without one, use a scope that
    // lives for this call only: no batching across calls, but nothing shared across requests either.
    const scope = registry ?? new GraphQLLoaderRegistry();
    const rawLoad = loadFn;
    loadFn = (k: TKey) => batchLoadScopeStorage.run(scope, () => rawLoad(k));

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

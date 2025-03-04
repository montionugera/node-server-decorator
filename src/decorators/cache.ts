export function cache(cacheAdapter: any, TTL: number) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = function (...args: any[]) {
      const key = `${target.constructor.name}.${propertyKey}(${args.join(',')})`;

      // Handle synchronous methods
      if (!originalMethod.constructor.name.includes('AsyncFunction')) {
        const cached = cacheAdapter.get(key);
        if (cached instanceof Promise) {
          return cached;
        }
        if (cached !== undefined) {
          return cached;
        }
        const result = originalMethod.apply(this, args);
        cacheAdapter.set(key, result, TTL);
        return result;
      }

      // Handle asynchronous methods
      return (async () => {
        const cached = await cacheAdapter.get(key);
        if (cached !== undefined) {
          return cached;
        }
        const result = await originalMethod.apply(this, args);
        await cacheAdapter.set(key, result, TTL);
        return result;
      })();
    };
    return descriptor;
  };
}

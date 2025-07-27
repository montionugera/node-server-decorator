import { globalLogger } from '../logger';
import { globalTracker } from '../tracker';

export function newDecorator(options: any = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const start = Date.now();
      const key = `${target.constructor.name}.${propertyKey}`;
      let result: any;
      let isError = false;
      let foundError: Error | null = null;

      try {
        // Pre-execution logic here
        result = await originalMethod.apply(this, args);
        // Post-execution success logic here
      } catch (error) {
        foundError = error as Error;
        isError = true;
        globalLogger.error(`[NewDecorator] ${key} - Error: ${foundError}`);
        throw error;
      } finally {
        const latency = Date.now() - start;
        globalTracker.track(key, latency, isError);
      }

      return result;
    };

    return descriptor;
  };
} 
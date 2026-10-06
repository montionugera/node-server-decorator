export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  factor?: number;
  jitter?: boolean;
  retryIf?: (error: Error) => boolean;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/**
 * @retry decorator wraps a method with exponential backoff and jitter retry semantics.
 */
export function retry(options: RetryOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`@retry: maxAttempts must be an integer >= 1, got ${maxAttempts}`);
  }
  const backoffMs = options.backoffMs ?? 50;
  const maxBackoffMs = options.maxBackoffMs ?? 2000;
  const factor = options.factor ?? 2.0;
  const jitter = options.jitter ?? true;
  const retryIf = options.retryIf;

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = originalMethod.apply(this, args);
          return isThenable(res) ? await res : res;
        } catch (err) {
          if (attempt >= maxAttempts) {
            throw err;
          }
          if (retryIf && !retryIf(err as Error)) {
            throw err;
          }

          let delay = backoffMs * Math.pow(factor, attempt - 1);
          if (delay > maxBackoffMs) {
            delay = maxBackoffMs;
          }
          if (jitter && delay > 0) {
            delay = Math.random() * delay;
          }

          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    };
    return descriptor;
  };
}

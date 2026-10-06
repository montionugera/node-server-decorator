/** Runs fn when a slot is free and resolves or rejects with fn's outcome. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Admit at most `max` concurrent fn executions. Extra callers queue first-in first-out.
 *
 * In-process only: there is no queue bound, no timeout and no cancellation, so a task that never
 * settles holds its slot forever. fn always starts on a later microtask, never synchronously.
 *
 * @throws RangeError when max is not an integer >= 1.
 */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createLimiter: max must be an integer >= 1, got ${max}`);
  }

  let active = 0;
  const waiters: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active++;
        resolve();
      });
    });
  };

  // The freed slot goes to the first waiter synchronously, so a caller arriving in the same tick
  // cannot take it ahead of the queue and the count never exceeds `max`.
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

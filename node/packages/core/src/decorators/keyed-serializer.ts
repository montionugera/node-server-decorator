export interface KeyedSerializer {
  /** Runs fn after every earlier task for the same key has settled. */
  <T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Number of keys that have a task queued or running. */
  readonly size: number;
}

/**
 * Each call returns an independent serializer with its own key space.
 *
 * Tasks of one key run one at a time in call order; different keys run in parallel. A failed task
 * never blocks its key. In-process only, with no timeout and no cancellation. fn always starts on
 * a later microtask, never synchronously.
 */
export function createKeyedSerializer(): KeyedSerializer {
  // Per key: a promise that settles (never rejects) when the last submitted task has settled.
  const tails = new Map<string, Promise<void>>();

  const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // `() => fn()` so fn never receives the previous task's value as an argument.
    const result = prev.then(() => fn());
    // Drop the key once its last task settles, so the map does not grow per distinct key.
    const forget = (): void => {
      if (tails.get(key) === tail) tails.delete(key);
    };
    const tail: Promise<void> = result.then(forget, forget);
    tails.set(key, tail);
    // A separate promise for the caller: `tail` handles `result`, so returning `result` itself
    // would hide a rejection the caller ignores from `unhandledRejection`.
    return result.then((value) => value);
  };

  return Object.defineProperty(serialize, 'size', {
    get: () => tails.size,
    enumerable: true,
  }) as KeyedSerializer;
}

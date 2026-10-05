import { createLimiter } from './limiter';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createLimiter', () => {
  it('never runs more than `max` fns concurrently (2, like the claude -p semaphore)', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];

    const task = () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
      });

    const all = Promise.all([task(), task(), task(), task(), task()]);
    await tick();
    expect(active).toBe(2); // only two admitted
    expect(releases.length).toBe(2);

    releases.shift()!();
    await tick();
    expect(active).toBe(2); // freed slot handed to the next waiter
    expect(peak).toBe(2);

    while (releases.length) releases.shift()!();
    await tick();
    while (releases.length) releases.shift()!();
    await tick();
    await all;
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('runs queued tasks in FIFO order', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limit(async () => {
          order.push(n);
          await tick();
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('releases the slot when the fn rejects', async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates resolved values', async () => {
    const limit = createLimiter(2);
    await expect(limit(async () => 42)).resolves.toBe(42);
  });

  it('hands a freed slot to the queue ahead of a caller arriving in the same tick', async () => {
    const limit = createLimiter(1);
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const run = (name: string, after?: () => void) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(name);
        await tick();
        active--;
        after?.();
      });

    let late: Promise<void> | undefined;
    // `late` is submitted synchronously as the first task ends, before its slot is released.
    const first = run('first', () => {
      late = run('late');
    });
    const queued = run('queued');
    await Promise.all([first, queued]);
    await late;

    expect(order).toEqual(['first', 'queued', 'late']);
    expect(peak).toBe(1);
  });

  it('never calls fn synchronously, even when a slot is free', async () => {
    const limit = createLimiter(1);
    let called = false;
    const done = limit(async () => {
      called = true;
    });
    expect(called).toBe(false);
    await done;
    expect(called).toBe(true);
  });

  it('rejects with the same error object fn rejected with', async () => {
    const limit = createLimiter(1);
    const error = new Error('boom');
    await expect(limit(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('rejects and frees the slot when fn throws synchronously', async () => {
    const limit = createLimiter(1);
    const error = new Error('sync boom');
    const throwing = (): Promise<string> => {
      throw error;
    };
    await expect(limit(throwing)).rejects.toBe(error);
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });

  it.each([0, -1, 1.5, NaN, Infinity])('throws RangeError for max = %p', (max) => {
    expect(() => createLimiter(max)).toThrow(RangeError);
  });

  it('accepts max = 1', () => {
    expect(() => createLimiter(1)).not.toThrow();
  });

  it('keeps two limiters independent', async () => {
    const a = createLimiter(1);
    const b = createLimiter(1);
    let releaseA!: () => void;
    const held = a(() => new Promise<void>((r) => (releaseA = r)));
    await tick();

    // `a` is full; `b` still has its own free slot.
    await expect(b(async () => 'b ran')).resolves.toBe('b ran');

    releaseA();
    await held;
  });

  it('lets a task that never settles hold its slot', async () => {
    const limit = createLimiter(1);
    let ranSecond = false;
    void limit(() => new Promise<void>(() => undefined));
    void limit(async () => {
      ranSecond = true;
    });
    await tick();
    await tick();
    expect(ranSecond).toBe(false);
  });
});

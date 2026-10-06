import { AsyncLocalStorage } from 'async_hooks';
import { setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import { batchLoad } from './batch-load';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeL2() {
  const store = new Map<string, any>();
  const calls = { mget: 0, setMany: 0, del: 0 };
  return {
    store,
    calls,
    adapter: {
      async mget(keys: string[]) {
        calls.mget++;
        const res = new Map<string, any>();
        for (const k of keys) if (store.has(k)) res.set(k, store.get(k));
        return res;
      },
      async setMany(items: Map<string, any>) {
        calls.setMany++;
        for (const [k, v] of items.entries()) store.set(k, v);
      },
      async del(keys: string[]) {
        calls.del++;
        for (const k of keys) store.delete(k);
      },
    },
  };
}

describe('@batchLoad regressions', () => {
  describe('plain-object batch result with non-string keys', () => {
    it('resolves numeric keys from a Record result and does not negative-cache them', async () => {
      let batchCalls = 0;
      class Svc {
        async findMany(ids: number[]): Promise<Record<string, { id: number }>> {
          batchCalls++;
          const out: Record<string, { id: number }> = {};
          for (const id of ids) if (id !== 404) out[id] = { id };
          return out;
        }

        @batchLoad({ batchMethod: 'findMany' })
        async find(_id: number): Promise<{ id: number } | undefined> {
          return undefined;
        }
      }
      const svc = new Svc();

      const [a, b, missing] = await Promise.all([svc.find(1), svc.find(2), svc.find(404)]);
      expect(a).toEqual({ id: 1 });
      expect(b).toEqual({ id: 2 });
      expect(missing).toBeUndefined();
      expect(batchCalls).toBe(1);

      // Served from L1 as a value (not as a negative entry), without a second batch call.
      expect(await svc.find(1)).toEqual({ id: 1 });
      expect(batchCalls).toBe(1);
    });

    it('still prefers an exact-key match when the result is a Map', async () => {
      class Svc {
        async findMany(ids: number[]): Promise<Map<number, string>> {
          return new Map(ids.map((id) => [id, `v${id}`] as [number, string]));
        }

        @batchLoad({ batchMethod: 'findMany' })
        async find(_id: number): Promise<string | undefined> {
          return undefined;
        }
      }
      expect(await new Svc().find(7)).toBe('v7');
    });
  });

  describe('clear() racing an in-flight load', () => {
    function makeService(l2?: ReturnType<typeof makeL2>) {
      const db = new Map<number, string>([[1, 'old']]);
      const gates: Array<{ promise: Promise<void>; resolve: (v: void) => void }> = [];
      let batchCalls = 0;
      class Svc {
        async findMany(ids: number[]): Promise<Map<number, string>> {
          batchCalls++;
          // Read first, then block: the value is captured before any later invalidation.
          const snapshot = new Map(ids.map((id) => [id, db.get(id)!] as [number, string]));
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
          return snapshot;
        }

        @batchLoad({
          batchMethod: 'findMany',
          cache: l2 ? { l2: { adapter: l2.adapter } } : undefined,
        })
        async find(_id: number): Promise<string | undefined> {
          return undefined;
        }
      }
      return { svc: new Svc(), db, gates, calls: () => batchCalls };
    }

    it('starts a fresh flight for reads issued after clear and never caches the stale value', async () => {
      const l2 = makeL2();
      const { svc, db, gates, calls } = makeService(l2);

      const first = svc.find(1);
      await tick(5);
      expect(calls()).toBe(1); // flight 1 has read 'old' and is blocked

      db.set(1, 'new');
      await (svc.find as any).clear(1, svc);

      const afterClear = svc.find(1);
      await tick(5);
      expect(calls()).toBe(2); // did not join the pre-invalidation flight

      gates[1].resolve();
      expect(await afterClear).toBe('new');

      gates[0].resolve();
      expect(await first).toBe('old'); // the read that began before the write keeps its value
      await tick(5);

      // The late-settling stale flight must not overwrite L1 or L2.
      expect(await svc.find(1)).toBe('new');
      expect(calls()).toBe(2);
      expect(l2.store.get('1')).toBe('new');
    });

    it('does not write the stale value to L1/L2 when no read follows the clear', async () => {
      const l2 = makeL2();
      const { svc, db, gates, calls } = makeService(l2);

      const first = svc.find(1);
      await tick(5);
      db.set(1, 'new');
      await (svc.find as any).clear(1); // no instance: cross-scope clear
      gates[0].resolve();
      expect(await first).toBe('old');
      await tick(5);

      expect(l2.store.has('1')).toBe(false);
      const next = svc.find(1);
      await tick(5);
      expect(calls()).toBe(2); // L1 did not serve 'old'
      gates[1].resolve();
      expect(await next).toBe('new');
    });

    it('does not negative-cache a key cleared while its lookup was in flight', async () => {
      const db = new Map<number, string>();
      const gates: Array<ReturnType<typeof deferred<void>>> = [];
      let batchCalls = 0;
      class Svc {
        async findMany(ids: number[]): Promise<Map<number, string>> {
          batchCalls++;
          const snapshot = new Map<number, string>();
          for (const id of ids) if (db.has(id)) snapshot.set(id, db.get(id)!);
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
          return snapshot;
        }

        @batchLoad({ batchMethod: 'findMany' })
        async find(_id: number): Promise<string | undefined> {
          return undefined;
        }
      }
      const svc = new Svc();

      const first = svc.find(1);
      await tick(5);
      db.set(1, 'created');
      await (svc.find as any).clear(1, svc);
      gates[0].resolve();
      expect(await first).toBeUndefined();

      const next = svc.find(1);
      await tick(5);
      expect(batchCalls).toBe(2); // not answered from a stale negative entry
      gates[1].resolve();
      expect(await next).toBe('created');
    });

    it('keeps deduplicating once the invalidated flight has settled', async () => {
      const { svc, db, gates, calls } = makeService();
      const first = svc.find(1);
      await tick(5);
      db.set(1, 'new');
      await (svc.find as any).clear(1, svc);

      const second = svc.find(1);
      gates[0].resolve(); // old flight settles while the new one is still in flight
      await first;
      await tick(5);
      const third = svc.find(1); // must join the new flight, not start a third
      await tick(5);
      expect(calls()).toBe(2);
      gates[1].resolve();
      expect(await second).toBe('new');
      expect(await third).toBe('new');
    });
  });

  describe('per-scope queue retention', () => {
    setFlagsFromString('--expose-gc');
    const gc: () => void = runInNewContext('gc');
    const WeakRefCtor: any = (globalThis as any).WeakRef;

    /** Runs GC rounds until at most `threshold` refs are still alive, or the deadline passes. Returns the live count. */
    async function collectUntil(refs: any[], threshold: number, deadlineMs = 2000): Promise<number> {
      const alive = () => refs.filter((ref) => ref.deref() !== undefined).length;
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        await tick(1);
        await new Promise((r) => setImmediate(r));
        gc();
        const count = alive();
        if (count < threshold || Date.now() >= deadline) return count;
      }
    }

    it('does not retain a finished request scope (queue + L1 values) and clears L2 once', async () => {
      const als = new AsyncLocalStorage<object>();
      const l2 = makeL2();
      class Svc {
        async findMany(ids: string[]): Promise<Map<string, { id: string; blob: number[] }>> {
          return new Map(
            ids.map((id) => [id, { id, blob: new Array(1024).fill(1) }] as [string, any])
          );
        }

        @batchLoad({
          batchMethod: 'findMany',
          contextStorage: als,
          cache: { l2: { adapter: l2.adapter } },
        })
        async find(_id: string): Promise<{ id: string; blob: number[] } | undefined> {
          return undefined;
        }
      }
      const svc = new Svc();

      async function runRequest(key: string) {
        let scopeRef: any;
        let valueRef: any;
        await als.run({}, async () => {
          scopeRef = new WeakRefCtor(als.getStore()!);
          const val = await svc.find(key);
          valueRef = new WeakRefCtor(val);
        });
        return { scopeRef, valueRef };
      }

      const N = 200;
      const scopes: any[] = [];
      const values: any[] = [];
      for (let i = 0; i < N; i++) {
        const { scopeRef, valueRef } = await runRequest(`k${i}`);
        scopes.push(scopeRef);
        values.push(valueRef);
      }
      l2.store.clear(); // L2 holds the values strongly; it is not what is under test

      expect(await collectUntil(scopes, N / 10)).toBeLessThan(N / 10);
      expect(await collectUntil(values, N / 10)).toBeLessThan(N / 10);

      // Invalidation cost must not grow with the number of requests served.
      l2.calls.del = 0;
      await als.run({}, async () => {
        await svc.find('live');
        await (svc.find as any).clear('live');
      });
      expect(l2.calls.del).toBe(1);
    });

    it('does not retain transient service instances (queue + L1 values)', async () => {
      class TransientSvc {
        async findMany(ids: string[]): Promise<Map<string, { id: string; blob: number[] }>> {
          return new Map(
            ids.map((id) => [id, { id, blob: new Array(1024).fill(1) }] as [string, any])
          );
        }

        @batchLoad({ batchMethod: 'findMany' })
        async find(_id: string): Promise<{ id: string; blob: number[] } | undefined> {
          return undefined;
        }
      }

      async function createAndLoad(key: string) {
        const instance = new TransientSvc();
        const instanceRef = new WeakRefCtor(instance);
        const val = await instance.find(key);
        const valueRef = new WeakRefCtor(val);
        return { instanceRef, valueRef };
      }

      const N = 200;
      const instances: any[] = [];
      const values: any[] = [];
      for (let i = 0; i < N; i++) {
        const { instanceRef, valueRef } = await createAndLoad(`k${i}`);
        instances.push(instanceRef);
        values.push(valueRef);
      }

      expect(await collectUntil(instances, N / 10)).toBeLessThan(N / 10);
      expect(await collectUntil(values, N / 10)).toBeLessThan(N / 10);
    });

    it('clear() without an instance still invalidates every live scope', async () => {
      const als = new AsyncLocalStorage<object>();
      let calls = 0;
      class Svc {
        async findMany(ids: string[]): Promise<Map<string, string>> {
          calls++;
          return new Map(ids.map((id) => [id, `v${calls}`] as [string, string]));
        }

        @batchLoad({ batchMethod: 'findMany', contextStorage: als })
        async find(_id: string): Promise<string | undefined> {
          return undefined;
        }
      }
      const svc = new Svc();
      const storeA = {};
      const storeB = {};

      expect(await als.run(storeA, () => svc.find('x'))).toBe('v1');
      expect(await als.run(storeB, () => svc.find('x'))).toBe('v2');
      await (svc.find as any).clear('x');
      expect(await als.run(storeA, () => svc.find('x'))).toBe('v3');
      expect(await als.run(storeB, () => svc.find('x'))).toBe('v4');
    });
  });
});

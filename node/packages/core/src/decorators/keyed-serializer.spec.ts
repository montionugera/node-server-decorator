import { execFileSync } from 'child_process';
import * as path from 'path';
import { createKeyedSerializer } from './keyed-serializer';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Child-process script (cwd = package root). It compiles keyed-serializer.ts, registers a real
 * `unhandledRejection` listener, and prints what the listener saw: first for a deliberately
 * unhandled rejection (the positive control), then for a serializer whose task rejects while the
 * caller handles its own promise, then for a rejected task whose promise the caller ignores.
 */
const UNHANDLED_REJECTION_PROBE = `
const fs = require('fs');
const Module = require('module');
const ts = require('typescript');
const file = require('path').resolve('src/decorators/keyed-serializer.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = new Module(file);
mod._compile(compiled, file);
const { createKeyedSerializer } = mod.exports;

const seen = [];
process.on('unhandledRejection', (reason) => seen.push(reason.message));
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  Promise.reject(new Error('control'));
  await tick();
  await tick();
  const control = seen.splice(0);

  const serialize = createKeyedSerializer();
  const failed = serialize('k', () => Promise.reject(new Error('boom')));
  const next = serialize('k', async () => 'ok');
  await failed.catch(() => undefined);
  await next;
  await tick();
  await tick();
  const chain = seen.splice(0);

  // A rejection the caller ignores is still the caller's own unhandled rejection.
  serialize('k', () => Promise.reject(new Error('ignored by caller')));
  await tick();
  await tick();
  process.stdout.write(JSON.stringify({ control, chain, ignored: seen }));
})();
`;

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createKeyedSerializer', () => {
  it('runs tasks of one key one at a time, in call order', async () => {
    const serialize = createKeyedSerializer();
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    const task = (name: string) =>
      serialize('gpu-0', async () => {
        active++;
        peak = Math.max(peak, active);
        events.push(`start ${name}`);
        await tick();
        events.push(`end ${name}`);
        active--;
      });

    await Promise.all([task('a'), task('b'), task('c')]);

    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(peak).toBe(1);
  });

  it('runs different keys in parallel', async () => {
    const serialize = createKeyedSerializer();
    const gateA = deferred();
    const started: string[] = [];
    const a = serialize('a', async () => {
      started.push('a');
      await gateA.promise;
    });
    const b = serialize('b', async () => {
      started.push('b');
      return 'b done';
    });

    // `b` finishes while `a` is still running.
    await expect(b).resolves.toBe('b done');
    expect(started).toEqual(['a', 'b']);

    gateA.resolve();
    await a;
  });

  it('keeps the key usable after a task rejects', async () => {
    const serialize = createKeyedSerializer();
    const failed = serialize('k', () => Promise.reject(new Error('boom')));
    const next = serialize('k', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('keeps the key usable after a task throws synchronously', async () => {
    const serialize = createKeyedSerializer();
    const error = new Error('sync boom');
    const failed = serialize('k', (): Promise<string> => {
      throw error;
    });
    const next = serialize('k', async () => 'ok');
    await expect(failed).rejects.toBe(error);
    await expect(next).resolves.toBe('ok');
  });

  it("gives each caller its own fn's outcome, never an earlier error", async () => {
    const serialize = createKeyedSerializer();
    const error = new Error('first failed');
    const first = serialize('k', () => Promise.reject(error));
    const second = serialize('k', async () => 2);
    const third = serialize('k', async () => 3);
    await expect(first).rejects.toBe(error);
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(3);
  });

  it('never calls fn synchronously, even when the key is idle', async () => {
    const serialize = createKeyedSerializer();
    let called = false;
    const done = serialize('k', async () => {
      called = true;
    });
    expect(called).toBe(false);
    await done;
    expect(called).toBe(true);
  });

  it('calls fn with no arguments, after a resolved and after a rejected task', async () => {
    const serialize = createKeyedSerializer();
    const argCounts: number[] = [];
    const record = async (...args: unknown[]) => {
      argCounts.push(args.length);
    };
    const resolved = serialize('k', async () => 'a value');
    const afterResolved = serialize('k', record);
    const rejected = serialize('k', () => Promise.reject(new Error('an error')));
    const afterRejected = serialize('k', record);

    await resolved;
    await afterResolved;
    await expect(rejected).rejects.toThrow('an error');
    await afterRejected;

    expect(argCounts).toEqual([0, 0]);
  });

  it('causes no unhandledRejection from its internal chain', () => {
    // Jest gives each test file a copy of `process`, so a listener registered here never sees a
    // real `unhandledRejection`. The check therefore runs in a child Node process, where the
    // positive control proves the listener is live.
    const stdout = execFileSync(process.execPath, ['-e', UNHANDLED_REJECTION_PROBE], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    });
    expect(JSON.parse(stdout)).toEqual({
      control: ['control'],
      chain: [],
      ignored: ['ignored by caller'],
    });
  });

  it('reports size 1 while a task runs and 0 after the last task of every key settles', async () => {
    const serialize = createKeyedSerializer();
    expect(serialize.size).toBe(0);

    const gate = deferred();
    const first = serialize('a', () => gate.promise);
    const second = serialize('a', async () => undefined);
    expect(serialize.size).toBe(1); // two tasks, one key

    const other = serialize('b', () => Promise.reject(new Error('boom')));
    expect(serialize.size).toBe(2);
    await expect(other).rejects.toThrow('boom');
    expect(serialize.size).toBe(1); // a failed task also removes its key

    gate.resolve();
    await first;
    expect(serialize.size).toBe(1); // `second` is still queued on the key
    await second;
    expect(serialize.size).toBe(0);
  });

  it('keeps two serializers independent for the same key', async () => {
    const one = createKeyedSerializer();
    const two = createKeyedSerializer();
    const gate = deferred();
    const held = one('k', () => gate.promise);

    await expect(two('k', async () => 'two ran')).resolves.toBe('two ran');
    expect(one.size).toBe(1);
    expect(two.size).toBe(0);

    gate.resolve();
    await held;
  });
});

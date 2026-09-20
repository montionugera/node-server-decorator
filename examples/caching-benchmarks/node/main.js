const path = require('path');
const { performance } = require('perf_hooks');

const batchLoadPath = path.resolve(__dirname, '../../../node/packages/core/dist/decorators/batch-load');
const { batchLoad } = require(batchLoadPath);

function applyBatchLoad(cls, methodName, options) {
  const desc = Object.getOwnPropertyDescriptor(cls.prototype, methodName);
  const dec = batchLoad(options);
  dec(cls.prototype, methodName, desc);
  Object.defineProperty(cls.prototype, methodName, desc);
}

function calcPercentiles(latenciesUs) {
  if (latenciesUs.length === 0) return [0, 0, 0, 0];
  latenciesUs.sort((a, b) => a - b);
  const sum = latenciesUs.reduce((acc, val) => acc + val, 0);
  const mean = sum / latenciesUs.length;
  const p50 = latenciesUs[Math.floor(latenciesUs.length * 0.50)];
  const p95 = latenciesUs[Math.floor(latenciesUs.length * 0.95)];
  const p99 = latenciesUs[Math.floor(latenciesUs.length * 0.99)];
  return [mean, p50, p95, p99];
}

// ----------------------------------------------------
// 1. L1 LRU Hit Benchmark
// ----------------------------------------------------
let l1DbCalls = 0;
class L1Service {
  async batchLookup(keys) {
    l1DbCalls++;
    const map = new Map();
    for (const k of keys) {
      map.set(k, { id: k, val: 'val-' + k });
    }
    return map;
  }

  async get(key) {
    return undefined;
  }
}
applyBatchLoad(L1Service, 'get', {
  batchMethod: 'batchLookup',
  cache: { l1: { maxEntries: 10000, ttlMs: 60000 } },
});

async function benchL1Hit(totalOps) {
  const svc = new L1Service();
  // Warm up and prime key
  svc.get.prime('hot-key', { id: 'hot-key', val: 'val-hot-key' }, svc);

  const latenciesUs = new Array(totalOps);
  const t0 = performance.now();

  for (let i = 0; i < totalOps; i++) {
    const s = performance.now();
    await svc.get('hot-key');
    const e = performance.now();
    latenciesUs[i] = (e - s) * 1000;
  }

  const durationMs = performance.now() - t0;
  const [mean, p50, p95, p99] = calcPercentiles(latenciesUs);

  return {
    language: 'Node/TypeScript',
    benchmark: 'L1_LRU_Hit',
    total_operations: totalOps,
    duration_ms: durationMs,
    throughput_ops_sec: (totalOps / durationMs) * 1000,
    mean_latency_us: mean,
    p50_latency_us: p50,
    p95_latency_us: p95,
    p99_latency_us: p99,
    extra: {
      db_calls: l1DbCalls,
    },
  };
}

// ----------------------------------------------------
// 2. SingleFlight Contention Benchmark (1,000 callers)
// ----------------------------------------------------
let sfDbCalls = 0;
class SingleFlightService {
  async batchUsers(keys) {
    sfDbCalls++;
    await new Promise((r) => setTimeout(r, 5));
    const map = new Map();
    for (const k of keys) {
      map.set(k, { id: k, name: 'User ' + k });
    }
    return map;
  }

  async getUser(key) {
    return undefined;
  }
}
applyBatchLoad(SingleFlightService, 'getUser', {
  batchMethod: 'batchUsers',
  deduplicate: true,
  windowMs: 2,
});

async function benchSingleFlightContention(concurrentCallers) {
  const svc = new SingleFlightService();
  const latenciesUs = new Array(concurrentCallers);

  const t0 = performance.now();
  const promises = [];

  for (let i = 0; i < concurrentCallers; i++) {
    const idx = i;
    const p = (async () => {
      const s = performance.now();
      const res = await svc.getUser('hot-user');
      const e = performance.now();
      latenciesUs[idx] = (e - s) * 1000;
      return res;
    })();
    promises.push(p);
  }

  await Promise.all(promises);
  const durationMs = performance.now() - t0;

  const [mean, p50, p95, p99] = calcPercentiles(latenciesUs);
  const coalescingRate = ((concurrentCallers - sfDbCalls) / concurrentCallers) * 100;

  return {
    language: 'Node/TypeScript',
    benchmark: 'SingleFlight_Contention',
    total_operations: concurrentCallers,
    duration_ms: durationMs,
    throughput_ops_sec: (concurrentCallers / durationMs) * 1000,
    mean_latency_us: mean,
    p50_latency_us: p50,
    p95_latency_us: p95,
    p99_latency_us: p99,
    extra: {
      db_calls: sfDbCalls,
      'coalescing_rate_%': coalescingRate,
    },
  };
}

// ----------------------------------------------------
// 3. Cascading Graph Prefetch vs Waterfall (100 parents x 3 children)
// ----------------------------------------------------
let waterfallParentCalls = 0;
let waterfallChildCalls = 0;

class UnprimedChildService {
  async batchChildren(keys) {
    waterfallChildCalls++;
    await new Promise((r) => setTimeout(r, 2));
    return keys.map((k) => ({ id: k, title: 'Child ' + k }));
  }

  async getChild(id) {
    return undefined;
  }
}
applyBatchLoad(UnprimedChildService, 'getChild', { batchMethod: 'batchChildren', windowMs: 1 });

class UnprimedParentService {
  async batchParents(keys) {
    waterfallParentCalls++;
    await new Promise((r) => setTimeout(r, 2));
    return keys.map((k) => ({
      id: k,
      children: [k + '-c1', k + '-c2', k + '-c3'],
    }));
  }

  async getParent(id) {
    return undefined;
  }
}
applyBatchLoad(UnprimedParentService, 'getParent', { batchMethod: 'batchParents', windowMs: 1 });

let prefetchParentCalls = 0;
let prefetchChildCalls = 0;

class PrimedChildService {
  async batchChildren(keys) {
    prefetchChildCalls++;
    await new Promise((r) => setTimeout(r, 2));
    return keys.map((k) => ({ id: k, title: 'Child ' + k }));
  }

  async getChild(id) {
    return undefined;
  }
}
applyBatchLoad(PrimedChildService, 'getChild', {
  batchMethod: 'batchChildren',
  windowMs: 1,
  cache: { l1: { maxEntries: 10000, ttlMs: 300000 } },
});

const pChildSvc = new PrimedChildService();

class PrimedParentService {
  async batchParents(keys) {
    prefetchParentCalls++;
    await new Promise((r) => setTimeout(r, 2));
    return keys.map((k) => ({
      id: k,
      children: [k + '-c1', k + '-c2', k + '-c3'],
    }));
  }

  async getParent(id) {
    return undefined;
  }
}
applyBatchLoad(PrimedParentService, 'getParent', {
  batchMethod: 'batchParents',
  windowMs: 1,
  prefetch: [
    {
      extract: (parent) => parent.children,
      loader: () => pChildSvc.getChild.bind(pChildSvc),
    },
  ],
});

const pParentSvc = new PrimedParentService();

async function benchCascadingPrefetch(parentCount) {
  const uChildSvc = new UnprimedChildService();
  const uParentSvc = new UnprimedParentService();

  const t0W = performance.now();
  for (let i = 0; i < parentCount; i++) {
    const parent = await uParentSvc.getParent(`p-${i}`);
    if (parent) {
      for (const cKey of parent.children) {
        await uChildSvc.getChild(cKey);
      }
    }
  }
  const durationW = performance.now() - t0W;
  const totalWQueries = waterfallParentCalls + waterfallChildCalls;

  const waterfall = {
    language: 'Node/TypeScript',
    benchmark: 'Cascading_Waterfall_Unprimed',
    total_operations: parentCount * 4,
    duration_ms: durationW,
    throughput_ops_sec: ((parentCount * 4) / durationW) * 1000,
    mean_latency_us: 0,
    p50_latency_us: 0,
    p95_latency_us: 0,
    p99_latency_us: 0,
    extra: {
      total_db_calls: totalWQueries,
    },
  };

  const t0P = performance.now();
  const parentPromises = [];
  for (let i = 0; i < parentCount; i++) {
    parentPromises.push(pParentSvc.getParent(`p-${i}`));
  }
  const parents = await Promise.all(parentPromises);

  await new Promise((r) => setTimeout(r, 15));

  for (const parent of parents) {
    if (parent) {
      for (const cKey of parent.children) {
        await pChildSvc.getChild(cKey);
      }
    }
  }
  const durationP = performance.now() - t0P;
  const totalPQueries = prefetchParentCalls + prefetchChildCalls;
  const speedup = durationW / durationP;

  const prefetch = {
    language: 'Node/TypeScript',
    benchmark: 'Cascading_Graph_Prefetch',
    total_operations: parentCount * 4,
    duration_ms: durationP,
    throughput_ops_sec: ((parentCount * 4) / durationP) * 1000,
    mean_latency_us: 0,
    p50_latency_us: 0,
    p95_latency_us: 0,
    p99_latency_us: 0,
    extra: {
      total_db_calls: totalPQueries,
      speedup_factor: Number(speedup.toFixed(2)),
      query_reduction: `${totalWQueries} -> ${totalPQueries} queries`,
    },
  };

  return { waterfall, prefetch };
}

async function main() {
  console.log('=== RUNNING NODE/TYPESCRIPT MULTITIER BENCHMARKS ===');

  const r1 = await benchL1Hit(100000);
  console.log(
    `[L1 Hit] Ops: ${r1.total_operations} | Time: ${r1.duration_ms.toFixed(1)}ms | Throughput: ${r1.throughput_ops_sec.toFixed(0)} ops/sec | Mean: ${r1.mean_latency_us.toFixed(2)}µs | P95: ${r1.p95_latency_us.toFixed(2)}µs | P99: ${r1.p99_latency_us.toFixed(2)}µs`
  );

  const r2 = await benchSingleFlightContention(1000);
  console.log(
    `[SingleFlight Contention] Callers: ${r2.total_operations} | DB Calls: ${r2.extra?.db_calls} | Coalescing Rate: ${r2.extra?.['coalescing_rate_%'].toFixed(2)}% | Mean: ${r2.mean_latency_us.toFixed(2)}µs`
  );

  const { waterfall: r3w, prefetch: r3p } = await benchCascadingPrefetch(100);
  console.log(
    `[Waterfall vs Prefetch] Unprimed: ${r3w.duration_ms.toFixed(1)}ms (${r3w.extra?.total_db_calls} queries) -> Prefetched: ${r3p.duration_ms.toFixed(1)}ms (${r3p.extra?.total_db_calls} queries) | Speedup: ${r3p.extra?.speedup_factor}x`
  );

  const results = [r1, r2, r3w, r3p];
  console.log('\n--- JSON SUMMARY ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);

import asyncio
import json
from pathlib import Path
import sys
import time
from typing import Any

# Ensure server_decorator is importable directly from repo source if needed
core_src = Path(__file__).resolve().parent.parent.parent.parent / "python" / "packages" / "core" / "src"
if core_src.exists() and str(core_src) not in sys.path:
    sys.path.insert(0, str(core_src))

from server_decorator.decorators.coalesce import PrefetchRule, batch_load


def calc_percentiles(latencies_us: list[float]) -> tuple[float, float, float, float]:
    if not latencies_us:
        return 0.0, 0.0, 0.0, 0.0
    latencies_us.sort()
    n = len(latencies_us)
    mean = sum(latencies_us) / n
    p50 = latencies_us[int(n * 0.50)]
    p95 = latencies_us[int(n * 0.95)]
    p99 = latencies_us[int(n * 0.99)]
    return mean, p50, p95, p99


# ----------------------------------------------------
# 1. L1 LRU Hit Benchmark
# ----------------------------------------------------
class L1Service:
    def __init__(self) -> None:
        self.db_calls = 0

    async def batch_lookup(self, keys: list[str]) -> dict[str, dict[str, str]]:
        self.db_calls += 1
        return {k: {"id": k, "val": f"val-{k}"} for k in keys}

    @batch_load(
        batch_method="batch_lookup",
        l1_max_size=10000,
        l1_ttl_seconds=60.0,
    )
    async def get(self, key: str) -> dict[str, str] | None:
        return None


async def bench_l1_hit(total_ops: int) -> dict[str, Any]:
    svc = L1Service()
    svc.get.prime("hot-key", {"id": "hot-key", "val": "val-hot-key"}, instance=svc)

    latencies_us: list[float] = [0.0] * total_ops
    t0 = time.perf_counter()

    for i in range(total_ops):
        s = time.perf_counter()
        await svc.get("hot-key")
        e = time.perf_counter()
        latencies_us[i] = (e - s) * 1_000_000.0

    duration_s = time.perf_counter() - t0
    duration_ms = duration_s * 1000.0
    mean, p50, p95, p99 = calc_percentiles(latencies_us)

    return {
        "language": "Python",
        "benchmark": "L1_LRU_Hit",
        "total_operations": total_ops,
        "duration_ms": duration_ms,
        "throughput_ops_sec": total_ops / duration_s if duration_s > 0 else 0,
        "mean_latency_us": mean,
        "p50_latency_us": p50,
        "p95_latency_us": p95,
        "p99_latency_us": p99,
        "extra": {
            "db_calls": svc.db_calls,
        },
    }


# ----------------------------------------------------
# 2. SingleFlight Contention Benchmark (1,000 callers)
# ----------------------------------------------------
class SingleFlightService:
    def __init__(self) -> None:
        self.db_calls = 0

    async def batch_users(self, keys: list[str]) -> dict[str, dict[str, str]]:
        self.db_calls += 1
        await asyncio.sleep(0.005)
        return {k: {"id": k, "name": f"User {k}"} for k in keys}

    @batch_load(
        batch_method="batch_users",
        deduplicate=True,
        window_seconds=0.002,
    )
    async def get_user(self, key: str) -> dict[str, str] | None:
        return None


async def bench_single_flight(concurrent_callers: int) -> dict[str, Any]:
    svc = SingleFlightService()
    latencies_us: list[float] = [0.0] * concurrent_callers

    async def call_worker(idx: int) -> Any:
        s = time.perf_counter()
        res = await svc.get_user("hot-user")
        e = time.perf_counter()
        latencies_us[idx] = (e - s) * 1_000_000.0
        return res

    t0 = time.perf_counter()
    tasks = [call_worker(i) for i in range(concurrent_callers)]
    await asyncio.gather(*tasks)
    duration_s = time.perf_counter() - t0
    duration_ms = duration_s * 1000.0

    mean, p50, p95, p99 = calc_percentiles(latencies_us)
    coalescing_rate = ((concurrent_callers - svc.db_calls) / concurrent_callers) * 100.0

    return {
        "language": "Python",
        "benchmark": "SingleFlight_Contention",
        "total_operations": concurrent_callers,
        "duration_ms": duration_ms,
        "throughput_ops_sec": concurrent_callers / duration_s if duration_s > 0 else 0,
        "mean_latency_us": mean,
        "p50_latency_us": p50,
        "p95_latency_us": p95,
        "p99_latency_us": p99,
        "extra": {
            "db_calls": svc.db_calls,
            "coalescing_rate_%": coalescing_rate,
        },
    }


# ----------------------------------------------------
# 3. Cascading Graph Prefetch vs Waterfall (100 parents x 3 children)
# ----------------------------------------------------
class UnprimedChildService:
    def __init__(self) -> None:
        self.db_calls = 0

    async def batch_children(self, keys: list[str]) -> list[dict[str, str]]:
        self.db_calls += 1
        await asyncio.sleep(0.002)
        return [{"id": k, "title": f"Child {k}"} for k in keys]

    @batch_load(batch_method="batch_children", window_seconds=0.001)
    async def get_child(self, key: str) -> dict[str, str] | None:
        return None


class UnprimedParentService:
    def __init__(self) -> None:
        self.db_calls = 0

    async def batch_parents(self, keys: list[str]) -> list[dict[str, Any]]:
        self.db_calls += 1
        await asyncio.sleep(0.002)
        return [
            {
                "id": k,
                "children": [f"{k}-c1", f"{k}-c2", f"{k}-c3"],
            }
            for k in keys
        ]

    @batch_load(batch_method="batch_parents", window_seconds=0.001)
    async def get_parent(self, key: str) -> dict[str, Any] | None:
        return None


class PrimedChildService:
    def __init__(self) -> None:
        self.db_calls = 0

    async def batch_children(self, keys: list[str]) -> list[dict[str, str]]:
        self.db_calls += 1
        await asyncio.sleep(0.002)
        return [{"id": k, "title": f"Child {k}"} for k in keys]

    @batch_load(
        batch_method="batch_children",
        window_seconds=0.001,
        l1_max_size=10000,
        l1_ttl_seconds=300.0,
    )
    async def get_child(self, key: str) -> dict[str, str] | None:
        return None


async def bench_cascading_prefetch(parent_count: int) -> tuple[dict[str, Any], dict[str, Any]]:
    u_child = UnprimedChildService()
    u_parent = UnprimedParentService()

    t0_w = time.perf_counter()
    for i in range(parent_count):
        parent = await u_parent.get_parent(f"p-{i}")
        if parent:
            for c_key in parent["children"]:
                await u_child.get_child(c_key)
    duration_w_ms = (time.perf_counter() - t0_w) * 1000.0
    total_w_queries = u_parent.db_calls + u_child.db_calls

    waterfall = {
        "language": "Python",
        "benchmark": "Cascading_Waterfall_Unprimed",
        "total_operations": parent_count * 4,
        "duration_ms": duration_w_ms,
        "throughput_ops_sec": (parent_count * 4) / (duration_w_ms / 1000.0),
        "mean_latency_us": 0,
        "p50_latency_us": 0,
        "p95_latency_us": 0,
        "p99_latency_us": 0,
        "extra": {
            "total_db_calls": total_w_queries,
        },
    }

    p_child = PrimedChildService()

    class PrimedParentService:
        def __init__(self) -> None:
            self.db_calls = 0

        async def batch_parents(self, keys: list[str]) -> list[dict[str, Any]]:
            self.db_calls += 1
            await asyncio.sleep(0.002)
            return [
                {
                    "id": k,
                    "children": [f"{k}-c1", f"{k}-c2", f"{k}-c3"],
                }
                for k in keys
            ]

        @batch_load(
            batch_method="batch_parents",
            window_seconds=0.001,
            prefetch=[
                PrefetchRule(
                    extract=lambda p: p.get("children"),
                    loader=lambda: p_child.get_child,
                )
            ],
        )
        async def get_parent(self, key: str) -> dict[str, Any] | None:
            return None

    p_parent = PrimedParentService()

    t0_p = time.perf_counter()
    parent_tasks = [p_parent.get_parent(f"p-{i}") for i in range(parent_count)]
    parents = await asyncio.gather(*parent_tasks)

    await asyncio.sleep(0.015)

    for parent in parents:
        if parent:
            for c_key in parent["children"]:
                await p_child.get_child(c_key)
    duration_p_ms = (time.perf_counter() - t0_p) * 1000.0
    total_p_queries = p_parent.db_calls + p_child.db_calls
    speedup = duration_w_ms / duration_p_ms if duration_p_ms > 0 else 0

    prefetch = {
        "language": "Python",
        "benchmark": "Cascading_Graph_Prefetch",
        "total_operations": parent_count * 4,
        "duration_ms": duration_p_ms,
        "throughput_ops_sec": (parent_count * 4) / (duration_p_ms / 1000.0),
        "mean_latency_us": 0,
        "p50_latency_us": 0,
        "p95_latency_us": 0,
        "p99_latency_us": 0,
        "extra": {
            "total_db_calls": total_p_queries,
            "speedup_factor": round(speedup, 2),
            "query_reduction": f"{total_w_queries} -> {total_p_queries} queries",
        },
    }

    return waterfall, prefetch


async def main() -> None:
    print("=== RUNNING PYTHON MULTITIER BENCHMARKS ===")

    r1 = await bench_l1_hit(100000)
    print(
        f"[L1 Hit] Ops: {r1['total_operations']} | Time: {r1['duration_ms']:.1f}ms | "
        f"Throughput: {r1['throughput_ops_sec']:.0f} ops/sec | Mean: {r1['mean_latency_us']:.2f}µs | "
        f"P95: {r1['p95_latency_us']:.2f}µs | P99: {r1['p99_latency_us']:.2f}µs"
    )

    r2 = await bench_single_flight(1000)
    print(
        f"[SingleFlight Contention] Callers: {r2['total_operations']} | DB Calls: {r2['extra']['db_calls']} | "
        f"Coalescing Rate: {r2['extra']['coalescing_rate_%']:.2f}% | Mean: {r2['mean_latency_us']:.2f}µs"
    )

    r3w, r3p = await bench_cascading_prefetch(100)
    print(
        f"[Waterfall vs Prefetch] Unprimed: {r3w['duration_ms']:.1f}ms ({r3w['extra']['total_db_calls']} queries) -> "
        f"Prefetched: {r3p['duration_ms']:.1f}ms ({r3p['extra']['total_db_calls']} queries) | Speedup: {r3p['extra']['speedup_factor']}x"
    )

    results = [r1, r2, r3w, r3p]
    print("\n--- JSON SUMMARY ---")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())

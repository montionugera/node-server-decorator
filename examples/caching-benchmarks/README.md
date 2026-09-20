# Polyglot Multi-Tier Caching & Pre-Fetching Benchmarks

Interactive empirical benchmark comparison suite across **Go**, **Node/TypeScript**, and **Python** for:
1. **L1 LRU In-Memory Cache Hit Throughput & Latency Distribution** (100,000 lookups)
2. **SingleFlight Concurrent Call Coalescing** (1,000 concurrent callers requesting a single cold key under 5ms simulated DB latency)
3. **Cascading Graph Pre-Fetching vs N+1 Waterfall Elimination** (100 parent entities $\times$ 3 children each = 400 total entity lookups)

---

## Quick Start

### Interactive Mode
Run the interactive CLI selector:
```bash
./examples/caching-benchmarks/run.sh
```

### CLI Direct Mode
Run specific language benchmarks or all:
```bash
# Run all benchmarks across Go, Node, and Python
./examples/caching-benchmarks/run.sh --all

# Run individual languages
./examples/caching-benchmarks/run.sh --go
./examples/caching-benchmarks/run.sh --node
./examples/caching-benchmarks/run.sh --python
```

---

## Benchmark Scenarios

### 1. L1 LRU In-Memory Hit (100,000 ops)
Evaluates raw in-memory lookup performance and latency distribution for pre-warmed / pre-primed entries.
- **Go**: `coalesce.NewMultiTierLoader` with `Prime`
- **Node/TypeScript**: `@batchLoad` with `get.prime`
- **Python**: `@batch_load` with `get.prime`

### 2. SingleFlight Contention (1,000 concurrent callers)
Fires 1,000 concurrent callers simultaneously against a cold cache key with 5ms simulated database query latency.
- Verifies that exactly **1 database call** is made (99.90% coalescing rate).
- Ensures no event loop starvation or goroutine deadlock.

### 3. Cascading Graph Pre-Fetching vs Waterfall (400 entities)
Compares naive sequential N+1 resolution (100 parent queries + 300 child queries) against relational pre-fetch hooks where resolving parents triggers batched background child pre-fetching directly into L1 cache.
- Slashes round-trips from **400 queries down to 4–5 batched queries** (~99% reduction).
- Yields **60x to 140x latency acceleration**.

---

## Reference Empirical Results (Apple Silicon M-series)

| Benchmark | Go | Node/TypeScript | Python (asyncio) |
| :--- | :--- | :--- | :--- |
| **L1 LRU Throughput** | ~3,360,000 ops/s | ~390,000 ops/s | ~600,000 ops/s |
| **L1 Mean Latency** | 2.43 $\mu$s | 2.47 $\mu$s | 1.57 $\mu$s |
| **SingleFlight DB Calls** | **1** (99.9% coalesced) | **1** (99.9% coalesced) | **1** (99.9% coalesced) |
| **Prefetch Speedup** | **139.8x** | **58.5x** | **69.6x** |
| **Query Reduction** | 400 $\rightarrow$ 4 queries | 400 $\rightarrow$ 4 queries | 400 $\rightarrow$ 4 queries |

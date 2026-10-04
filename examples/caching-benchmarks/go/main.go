package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

type BenchResult struct {
	Language         string         `json:"language"`
	Benchmark        string         `json:"benchmark"`
	TotalOperations  int            `json:"total_operations"`
	DurationMs       float64        `json:"duration_ms"`
	ThroughputOpsSec float64        `json:"throughput_ops_sec"`
	MeanLatencyUs    float64        `json:"mean_latency_us"`
	P50LatencyUs     float64        `json:"p50_latency_us"`
	P95LatencyUs     float64        `json:"p95_latency_us"`
	P99LatencyUs     float64        `json:"p99_latency_us"`
	Extra            map[string]any `json:"extra,omitempty"`
}

type Item struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Children []string `json:"children,omitempty"`
}

func calcPercentiles(durations []time.Duration) (mean, p50, p95, p99 float64) {
	if len(durations) == 0 {
		return 0, 0, 0, 0
	}
	sort.Slice(durations, func(i, j int) bool {
		return durations[i] < durations[j]
	})

	var sum int64
	for _, d := range durations {
		sum += d.Microseconds()
	}
	mean = float64(sum) / float64(len(durations))
	p50 = float64(durations[int(float64(len(durations))*0.50)].Microseconds())
	p95 = float64(durations[int(float64(len(durations))*0.95)].Microseconds())
	p99 = float64(durations[int(float64(len(durations))*0.99)].Microseconds())
	return
}

func benchL1Hit(totalOps int, workers int) BenchResult {
	loader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity: 10000,
		L1TTL:      5 * time.Minute,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{ID: k, Title: "Item " + k}
			}
			return res, nil
		},
	})
	defer loader.Close()

	ctx := context.Background()
	loader.Prime("hot-key", &Item{ID: "hot-key", Title: "Pre-warmed Item"})

	opsPerWorker := totalOps / workers
	var wg sync.WaitGroup
	allLatencies := make([]time.Duration, totalOps)

	start := time.Now()
	for w := 0; w < workers; w++ {
		wg.Add(1)
		offset := w * opsPerWorker
		go func(workerIdx int, startOffset int) {
			defer wg.Done()
			for i := 0; i < opsPerWorker; i++ {
				t0 := time.Now()
				_, _ = loader.Load(ctx, "hot-key")
				allLatencies[startOffset+i] = time.Since(t0)
			}
		}(w, offset)
	}

	wg.Wait()
	duration := time.Since(start)

	mean, p50, p95, p99 := calcPercentiles(allLatencies)

	return BenchResult{
		Language:         "Go",
		Benchmark:        "L1_LRU_Hit",
		TotalOperations:  len(allLatencies),
		DurationMs:       float64(duration.Milliseconds()),
		ThroughputOpsSec: float64(len(allLatencies)) / duration.Seconds(),
		MeanLatencyUs:    mean,
		P50LatencyUs:     p50,
		P95LatencyUs:     p95,
		P99LatencyUs:     p99,
	}
}

func benchSingleFlightContention(concurrentCallers int) BenchResult {
	var dbCalls int64
	loader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity:   10,
		L1TTL:        100 * time.Millisecond,
		BatchTimeout: 2 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			atomic.AddInt64(&dbCalls, 1)
			time.Sleep(5 * time.Millisecond) // Simulated DB query latency
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{ID: k, Title: "Item " + k}
			}
			return res, nil
		},
	})
	defer loader.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	latencies := make([]time.Duration, concurrentCallers)
	startBarrier := make(chan struct{})

	for i := 0; i < concurrentCallers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startBarrier
			t0 := time.Now()
			_, _ = loader.Load(ctx, "hot-key")
			latencies[idx] = time.Since(t0)
		}(i)
	}

	start := time.Now()
	close(startBarrier)
	wg.Wait()
	duration := time.Since(start)

	mean, p50, p95, p99 := calcPercentiles(latencies)
	totalDbCalls := atomic.LoadInt64(&dbCalls)
	coalescedRatio := float64(concurrentCallers-int(totalDbCalls)) / float64(concurrentCallers) * 100.0

	return BenchResult{
		Language:         "Go",
		Benchmark:        "SingleFlight_Contention",
		TotalOperations:  concurrentCallers,
		DurationMs:       float64(duration.Milliseconds()),
		ThroughputOpsSec: float64(concurrentCallers) / duration.Seconds(),
		MeanLatencyUs:    mean,
		P50LatencyUs:     p50,
		P95LatencyUs:     p95,
		P99LatencyUs:     p99,
		Extra: map[string]any{
			"db_calls":          totalDbCalls,
			"coalescing_rate_%": coalescedRatio,
		},
	}
}

func benchCascadingPrefetch(parentCount int) (waterfall BenchResult, prefetch BenchResult) {
	ctx := context.Background()

	// 1. Waterfall (no prefetch)
	var waterfallDbCalls int64
	unprimedChildLoader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity:   10000,
		L1TTL:        5 * time.Minute,
		BatchTimeout: 1 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			atomic.AddInt64(&waterfallDbCalls, 1)
			time.Sleep(2 * time.Millisecond)
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{ID: k, Title: "Child " + k}
			}
			return res, nil
		},
	})
	defer unprimedChildLoader.Close()

	var waterfallParentCalls int64
	unprimedParentLoader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity:   10000,
		L1TTL:        5 * time.Minute,
		BatchTimeout: 1 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			atomic.AddInt64(&waterfallParentCalls, 1)
			time.Sleep(2 * time.Millisecond)
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{
					ID:       k,
					Title:    "Parent " + k,
					Children: []string{k + "-c1", k + "-c2", k + "-c3"},
				}
			}
			return res, nil
		},
	})
	defer unprimedParentLoader.Close()

	startW := time.Now()
	for i := 0; i < parentCount; i++ {
		pKey := fmt.Sprintf("p-%d", i)
		p, _ := unprimedParentLoader.Load(ctx, pKey)
		if p != nil {
			for _, cKey := range p.Children {
				_, _ = unprimedChildLoader.Load(ctx, cKey)
			}
		}
	}
	durationW := time.Since(startW)

	waterfall = BenchResult{
		Language:         "Go",
		Benchmark:        "Cascading_Waterfall_Unprimed",
		TotalOperations:  parentCount * 4,
		DurationMs:       float64(durationW.Milliseconds()),
		ThroughputOpsSec: float64(parentCount*4) / durationW.Seconds(),
		Extra: map[string]any{
			"total_db_calls": atomic.LoadInt64(&waterfallParentCalls) + atomic.LoadInt64(&waterfallDbCalls),
		},
	}

	// 2. Cascading Prefetch
	var prefetchChildDbCalls int64
	primedChildLoader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity:   10000,
		L1TTL:        5 * time.Minute,
		BatchTimeout: 1 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			atomic.AddInt64(&prefetchChildDbCalls, 1)
			time.Sleep(2 * time.Millisecond)
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{ID: k, Title: "Child " + k}
			}
			return res, nil
		},
	})
	defer primedChildLoader.Close()

	var prefetchParentCalls int64
	primedParentLoader := coalesce.NewMultiTierLoader(coalesce.MultiTierConfig[string, *Item]{
		L1Capacity:   10000,
		L1TTL:        5 * time.Minute,
		BatchTimeout: 1 * time.Millisecond,
		PrefetchHooks: []coalesce.PrefetchHook[*Item]{
			func(ctx context.Context, items []*Item) {
				var childKeys []string
				for _, it := range items {
					if it != nil {
						childKeys = append(childKeys, it.Children...)
					}
				}
				if len(childKeys) > 0 {
					primedChildLoader.Prefetch(ctx, childKeys)
				}
			},
		},
		BatchFn: func(ctx context.Context, keys []string) (map[string]*Item, error) {
			atomic.AddInt64(&prefetchParentCalls, 1)
			time.Sleep(2 * time.Millisecond)
			res := make(map[string]*Item)
			for _, k := range keys {
				res[k] = &Item{
					ID:       k,
					Title:    "Parent " + k,
					Children: []string{k + "-c1", k + "-c2", k + "-c3"},
				}
			}
			return res, nil
		},
	})
	defer primedParentLoader.Close()

	startP := time.Now()
	var parentKeys []string
	for i := 0; i < parentCount; i++ {
		parentKeys = append(parentKeys, fmt.Sprintf("p-%d", i))
	}
	parents, _ := primedParentLoader.LoadMany(ctx, parentKeys)

	time.Sleep(5 * time.Millisecond)

	for _, p := range parents {
		if p != nil {
			for _, cKey := range p.Children {
				_, _ = primedChildLoader.Load(ctx, cKey)
			}
		}
	}
	durationP := time.Since(startP)

	totalPrefetchDbCalls := atomic.LoadInt64(&prefetchParentCalls) + atomic.LoadInt64(&prefetchChildDbCalls)
	speedup := float64(durationW) / float64(durationP)

	prefetch = BenchResult{
		Language:         "Go",
		Benchmark:        "Cascading_Graph_Prefetch",
		TotalOperations:  parentCount * 4,
		DurationMs:       float64(durationP.Milliseconds()),
		ThroughputOpsSec: float64(parentCount*4) / durationP.Seconds(),
		Extra: map[string]any{
			"total_db_calls":  totalPrefetchDbCalls,
			"speedup_factor":  speedup,
			"query_reduction": fmt.Sprintf("%d -> %d queries", atomic.LoadInt64(&waterfallParentCalls)+atomic.LoadInt64(&waterfallDbCalls), totalPrefetchDbCalls),
		},
	}

	return
}

func main() {
	fmt.Println("=== RUNNING GO MULTITIER BENCHMARKS ===")

	r1 := benchL1Hit(100000, 10)
	fmt.Printf("[L1 Hit] Ops: %d | Time: %.1fms | Throughput: %.0f ops/sec | Mean: %.2fµs | P95: %.2fµs | P99: %.2fµs\n",
		r1.TotalOperations, r1.DurationMs, r1.ThroughputOpsSec, r1.MeanLatencyUs, r1.P95LatencyUs, r1.P99LatencyUs)

	r2 := benchSingleFlightContention(1000)
	fmt.Printf("[SingleFlight Contention] Callers: %d | DB Calls: %v | Coalescing Rate: %.2f%% | Mean: %.2fµs\n",
		r2.TotalOperations, r2.Extra["db_calls"], r2.Extra["coalescing_rate_%"], r2.MeanLatencyUs)

	r3w, r3p := benchCascadingPrefetch(100)
	fmt.Printf("[Waterfall vs Prefetch] Unprimed: %.1fms (%v queries) -> Prefetched: %.1fms (%v queries) | Speedup: %.2fx\n",
		r3w.DurationMs, r3w.Extra["total_db_calls"], r3p.DurationMs, r3p.Extra["total_db_calls"], r3p.Extra["speedup_factor"])

	results := []BenchResult{r1, r2, r3w, r3p}
	bytes, _ := json.MarshalIndent(results, "", "  ")
	fmt.Println("\n--- JSON SUMMARY ---")
	fmt.Println(string(bytes))
}

package gqlloader_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/montionugera/node-server-decorator/v2/go/adapter/gqlloader"
	"github.com/montionugera/node-server-decorator/v2/go/core/coalesce"
)

type Author struct {
	ID   string
	Name string
}

type Book struct {
	ID       string
	AuthorID string
	Title    string
}

func TestGqlLoader(t *testing.T) {
	var mu sync.Mutex
	var dbQueries []string

	batchFindAuthors := func(ctx context.Context, ids []string) (map[string]*Author, error) {
		mu.Lock()
		dbQueries = append(dbQueries, fmt.Sprintf("SELECT * FROM authors WHERE id IN (%v)", ids))
		mu.Unlock()

		res := make(map[string]*Author)
		for _, id := range ids {
			res[id] = &Author{ID: id, Name: "Author " + id}
		}
		return res, nil
	}

	authorLoaderConfig := coalesce.Config[string, *Author]{
		BatchFn:      batchFindAuthors,
		Window:       5 * time.Millisecond,
		MaxBatchSize: 100,
	}

	t.Run("coalesces 50 concurrent resolver calls into 1 batch DB query", func(t *testing.T) {
		mu.Lock()
		dbQueries = nil
		mu.Unlock()

		reg := gqlloader.NewRegistry()
		ctx := gqlloader.WithContext(context.Background(), reg)

		var wg sync.WaitGroup
		results := make([]*Author, 50)

		// 50 books with 10 authors
		for i := 0; i < 50; i++ {
			idx := i
			authorID := fmt.Sprintf("auth-%d", i%10)
			wg.Add(1)
			go func() {
				defer wg.Done()
				author, err := gqlloader.Load(ctx, "authors", authorID, authorLoaderConfig)
				if err != nil {
					t.Errorf("load error: %v", err)
				}
				results[idx] = author
			}()
		}

		wg.Wait()

		if len(results) != 50 {
			t.Fatalf("expected 50 results, got %d", len(results))
		}
		if results[0].Name != "Author auth-0" {
			t.Errorf("unexpected author: %v", results[0])
		}

		mu.Lock()
		defer mu.Unlock()
		if len(dbQueries) != 1 {
			t.Errorf("expected exactly 1 DB query, got %d: %v", len(dbQueries), dbQueries)
		}
	})

	t.Run("isolates request-scoped caches across concurrent operations", func(t *testing.T) {
		regA := gqlloader.NewRegistry()
		ctxA := gqlloader.WithContext(context.Background(), regA)

		regB := gqlloader.NewRegistry()
		ctxB := gqlloader.WithContext(context.Background(), regB)

		authorA, errA := gqlloader.Load(ctxA, "authors", "auth-A", authorLoaderConfig)
		authorB, errB := gqlloader.Load(ctxB, "authors", "auth-B", authorLoaderConfig)

		if errA != nil || errB != nil {
			t.Fatalf("unexpected error: %v, %v", errA, errB)
		}
		if authorA.Name != "Author auth-A" || authorB.Name != "Author auth-B" {
			t.Errorf("unexpected results: %v, %v", authorA, authorB)
		}
	})
}

type userKey struct{}

// identityConfig returns a config whose BatchFn result depends on the request identity in ctx.
func identityConfig(mu *sync.Mutex, queries *[]string, window time.Duration, singleFlight bool) coalesce.Config[string, string] {
	return coalesce.Config[string, string]{
		Window:       window,
		SingleFlight: singleFlight,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			user, _ := ctx.Value(userKey{}).(string)
			mu.Lock()
			*queries = append(*queries, fmt.Sprintf("%s:%v", user, keys))
			mu.Unlock()
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			out := make(map[string]string, len(keys))
			for _, k := range keys {
				out[k] = user + ":" + k
			}
			return out, nil
		},
	}
}

func TestBatchFnSeesRequestContextValuesAndDeadline(t *testing.T) {
	var mu sync.Mutex
	var sawUser string
	var sawDeadline bool

	cfg := coalesce.Config[string, string]{
		Window: 2 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			mu.Lock()
			sawUser, _ = ctx.Value(userKey{}).(string)
			_, sawDeadline = ctx.Deadline()
			mu.Unlock()
			return map[string]string{keys[0]: "ok"}, nil
		},
	}

	for name, withRegistry := range map[string]bool{"registry": true, "no registry": false} {
		t.Run(name, func(t *testing.T) {
			mu.Lock()
			sawUser, sawDeadline = "", false
			mu.Unlock()

			ctx := context.WithValue(context.Background(), userKey{}, "alice")
			ctx, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			if withRegistry {
				ctx = gqlloader.WithContext(ctx, gqlloader.NewRegistry())
			}

			if _, err := gqlloader.Load(ctx, "docs", "doc1", cfg); err != nil {
				t.Fatalf("load error: %v", err)
			}

			mu.Lock()
			defer mu.Unlock()
			if sawUser != "alice" {
				t.Errorf("BatchFn must see request context values, got user=%q", sawUser)
			}
			if !sawDeadline {
				t.Errorf("BatchFn must see the request deadline")
			}
		})
	}
}

func TestBatchDeadlineIsNotImposedOnCallersWithoutOne(t *testing.T) {
	var sawDeadline bool
	cfg := coalesce.Config[string, string]{
		Window: 20 * time.Millisecond,
		BatchFn: func(ctx context.Context, keys []string) (map[string]string, error) {
			_, sawDeadline = ctx.Deadline()
			out := map[string]string{}
			for _, k := range keys {
				out[k] = "ok"
			}
			return out, nil
		},
	}
	base := gqlloader.WithContext(context.Background(), gqlloader.NewRegistry())
	short, cancel := context.WithTimeout(base, time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for i, ctx := range []context.Context{short, base} {
		wg.Add(1)
		go func(i int, ctx context.Context) {
			defer wg.Done()
			if _, err := gqlloader.Load(ctx, "docs", fmt.Sprintf("k%d", i), cfg); err != nil {
				t.Errorf("load error: %v", err)
			}
		}(i, ctx)
	}
	wg.Wait()
	if sawDeadline {
		t.Errorf("a caller without a deadline must not inherit another caller's deadline")
	}
}

func TestSameKeyInTwoRequestsIsNotShared(t *testing.T) {
	var mu sync.Mutex
	var queries []string
	cfg := identityConfig(&mu, &queries, 2*time.Millisecond, false)

	load := func(user string) string {
		ctx := context.WithValue(context.Background(), userKey{}, user)
		ctx = gqlloader.WithContext(ctx, gqlloader.NewRegistry())
		v, err := gqlloader.Load(ctx, "docs", "doc1", cfg)
		if err != nil {
			t.Fatalf("load error: %v", err)
		}
		return v
	}

	if a, b := load("alice"), load("bob"); a != "alice:doc1" || b != "bob:doc1" {
		t.Errorf("each request must load under its own identity, got %q and %q", a, b)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(queries) != 2 {
		t.Errorf("expected 2 batch calls, got %v", queries)
	}
}

func TestEarlierCallerCancellingDoesNotFailLaterLiveCaller(t *testing.T) {
	for name, singleFlight := range map[string]bool{"batch": false, "singleflight": true} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var queries []string
			cfg := identityConfig(&mu, &queries, 30*time.Millisecond, singleFlight)

			base := gqlloader.WithContext(context.Background(), gqlloader.NewRegistry())
			ctxA, cancelA := context.WithCancel(base)

			errA := make(chan error, 1)
			go func() {
				_, err := gqlloader.Load(ctxA, "docs", "a", cfg)
				errA <- err
			}()
			time.Sleep(5 * time.Millisecond)
			cancelA()
			if err := <-errA; err != context.Canceled {
				t.Fatalf("cancelled caller should get context.Canceled, got %v", err)
			}

			time.Sleep(5 * time.Millisecond)
			v, err := gqlloader.Load(base, "docs", "b", cfg)
			if err != nil || v != ":b" {
				t.Errorf("live caller must still get its value, got %q, %v", v, err)
			}
		})
	}
}

func TestSingleFlightFollowerSurvivesLeaderCancellation(t *testing.T) {
	var mu sync.Mutex
	var queries []string
	cfg := identityConfig(&mu, &queries, 30*time.Millisecond, true)

	base := gqlloader.WithContext(context.Background(), gqlloader.NewRegistry())
	leaderCtx, cancelLeader := context.WithCancel(base)

	leaderErr := make(chan error, 1)
	go func() {
		_, err := gqlloader.Load(leaderCtx, "docs", "same", cfg)
		leaderErr <- err
	}()
	time.Sleep(5 * time.Millisecond)

	type res struct {
		v   string
		err error
	}
	follower := make(chan res, 1)
	go func() {
		v, err := gqlloader.Load(base, "docs", "same", cfg)
		follower <- res{v, err}
	}()
	time.Sleep(5 * time.Millisecond)
	cancelLeader()

	if err := <-leaderErr; err != context.Canceled {
		t.Fatalf("leader should get context.Canceled, got %v", err)
	}
	if r := <-follower; r.err != nil || r.v != ":same" {
		t.Errorf("follower with a live context must get the value, got %q, %v", r.v, r.err)
	}
}

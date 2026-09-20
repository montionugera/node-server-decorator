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

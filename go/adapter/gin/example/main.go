package main

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	ginadapter "github.com/montionugera/node-server-decorator/go/adapter/gin/v2"
	"github.com/montionugera/node-server-decorator/go/adapter/gin/v2/internal/example"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

type userMemoryStore struct {
	mu    sync.RWMutex
	users map[string]map[string]any
}

func newStore() *userMemoryStore {
	return &userMemoryStore{
		users: make(map[string]map[string]any),
	}
}

func (s *userMemoryStore) List(ctx context.Context, limit, offset int, filters map[string]string) (any, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var filtered []map[string]any
	for _, u := range s.users {
		matches := true
		for k, v := range filters {
			if uv, ok := u[k].(string); !ok || uv != v {
				matches = false
				break
			}
		}
		if matches {
			filtered = append(filtered, u)
		}
	}

	total := len(filtered)
	start := offset
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}

	return filtered[start:end], total, nil
}

func (s *userMemoryStore) Get(ctx context.Context, id string) (any, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	u, ok := s.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	return u, nil
}

func (s *userMemoryStore) Create(ctx context.Context, payload map[string]any) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := fmt.Sprintf("u%d", len(s.users)+1)
	user := make(map[string]any)
	for k, v := range payload {
		user[k] = v
	}
	user["id"] = id
	user["loginCount"] = 0
	s.users[id] = user
	return user, nil
}

func (s *userMemoryStore) Update(ctx context.Context, id string, payload map[string]any) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	u, ok := s.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	for k, v := range payload {
		u[k] = v
	}
	return u, nil
}

func (s *userMemoryStore) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.users[id]; !ok {
		return httpserver.ErrNotFound
	}
	delete(s.users, id)
	return nil
}

func (s *userMemoryStore) Action(ctx context.Context, id string, action string, payload map[string]any) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	u, ok := s.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}

	switch action {
	case "activate":
		u["status"] = "active"
		return u, nil
	case "ping":
		return map[string]any{"pong": true}, nil
	default:
		return nil, fmt.Errorf("unknown action: %s", action)
	}
}

func setupRouter(store *userMemoryStore) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

	// Custom direct Gin endpoint demonstrating ShouldBindJSON with generated UserCreateDTO
	r.POST("/api/direct-bind/users", func(c *gin.Context) {
		var dto UserCreateDTO
		if err := c.ShouldBindJSON(&dto); err != nil {
			c.JSON(422, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"status": "valid", "email": dto.Email, "name": dto.Name})
	})

	// Scope extractor for EntitySpec declarative security
	authExtractor := func(c *gin.Context) (bool, []string, error) {
		auth := c.GetHeader("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			return false, nil, nil
		}
		token := strings.TrimPrefix(auth, "Bearer ")
		if token == "admin-token" {
			return true, []string{"user:write", "user:admin"}, nil
		}
		if token == "write-token" {
			return true, []string{"user:write"}, nil
		}
		return true, []string{"user:read"}, nil
	}

	// Mount EntitySpec CRUD + Actions onto Gin router
	ginadapter.MountRoutes(r, example.UserSpec, store, ginadapter.WithAuth(authExtractor))

	return r
}

func main() {
	store := newStore()
	r := setupRouter(store)
	_ = r.Run(":8080")
}

package ginadapter_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	ginadapter "github.com/montionugera/node-server-decorator/v2/go/adapter/gin"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
	"github.com/montionugera/node-server-decorator/v2/go/internal/example"
)

type mockUserHandler struct {
	users map[string]map[string]any
}

func newMockUserHandler() *mockUserHandler {
	return &mockUserHandler{
		users: make(map[string]map[string]any),
	}
}

func (m *mockUserHandler) List(ctx context.Context, limit, offset int, filters map[string]string) (any, int, error) {
	var filtered []map[string]any
	for _, u := range m.users {
		match := true
		for k, v := range filters {
			if uv, ok := u[k].(string); !ok || uv != v {
				match = false
				break
			}
		}
		if match {
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

func (m *mockUserHandler) Get(ctx context.Context, id string) (any, error) {
	u, ok := m.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	return u, nil
}

func (m *mockUserHandler) Create(ctx context.Context, payload map[string]any) (any, error) {
	id := fmt.Sprintf("u%d", len(m.users)+1)
	user := make(map[string]any)
	for k, v := range payload {
		user[k] = v
	}
	user["id"] = id
	user["loginCount"] = 0
	m.users[id] = user
	return user, nil
}

func (m *mockUserHandler) Update(ctx context.Context, id string, payload map[string]any) (any, error) {
	u, ok := m.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	for k, v := range payload {
		u[k] = v
	}
	return u, nil
}

func (m *mockUserHandler) Delete(ctx context.Context, id string) error {
	if _, ok := m.users[id]; !ok {
		return httpserver.ErrNotFound
	}
	delete(m.users, id)
	return nil
}

func (m *mockUserHandler) Action(ctx context.Context, id string, action string, payload map[string]any) (any, error) {
	u, ok := m.users[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	if action == "activate" {
		u["status"] = "active"
		return u, nil
	}
	if action == "ping" {
		return map[string]any{"pong": true}, nil
	}
	return nil, fmt.Errorf("unknown action: %s", action)
}

func TestToGinPath(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"/users/{id}", "/users/:id"},
		{"/users/{id}/actions/{action}", "/users/:id/actions/:action"},
		{"/teams/{team_id}/members/{user_id}", "/teams/:team_id/members/:user_id"},
		{"/ping", "/ping"},
	}

	for _, tc := range cases {
		got := ginadapter.ToGinPath(tc.in)
		if got != tc.want {
			t.Errorf("ToGinPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestMountRoutes(t *testing.T) {
	handler := newMockUserHandler()
	authExtractor := func(c *gin.Context) (bool, []string, error) {
		token := c.GetHeader("Authorization")
		if token == "Bearer admin-token" {
			return true, []string{"user:write", "user:admin"}, nil
		}
		if token == "Bearer write-token" {
			return true, []string{"user:write"}, nil
		}
		if token == "Bearer read-token" {
			return true, []string{"user:read"}, nil
		}
		return false, nil, nil
	}

	r := gin.New()
	ginadapter.MountRoutes(r, example.UserSpec, handler, ginadapter.WithAuth(authExtractor))

	// 1. Test POST /users with invalid payload -> 400 ValidationProblem
	t.Run("POST /users invalid payload", func(t *testing.T) {
		body := `{"email": "not-an-email", "name": "A"}`
		req := httptest.NewRequest("POST", "/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}

		var prob httpserver.ValidationProblem
		if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
			t.Fatalf("failed to decode ValidationProblem: %v", err)
		}
		if prob.Type != httpserver.ValidationProblemType {
			t.Errorf("expected type %q, got %q", httpserver.ValidationProblemType, prob.Type)
		}
		if prob.Status != 400 {
			t.Errorf("expected status 400, got %d", prob.Status)
		}
	})

	// 2. Test POST /users missing auth -> 401
	t.Run("POST /users missing auth", func(t *testing.T) {
		body := `{"email": "alice@example.com", "name": "Alice", "status": "inactive", "tags": ["admin"]}`
		req := httptest.NewRequest("POST", "/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}
	})

	// 3. Test POST /users valid with auth -> 201 Created
	t.Run("POST /users valid payload", func(t *testing.T) {
		body := map[string]any{
			"email":  "alice@example.com",
			"name":   "Alice",
			"status": "inactive",
			"tags":   []string{"admin"},
		}
		b, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/users", bytes.NewBuffer(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}

		var created map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
			t.Fatalf("failed to decode created user: %v", err)
		}
		if created["id"] != "u1" {
			t.Errorf("expected id u1, got %v", created["id"])
		}
	})

	// 4. Test GET /users list with query params -> 200
	t.Run("GET /users pagination & filter", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users?limit=10&offset=0&status=inactive", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var res map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode list response: %v", err)
		}
		if res["total"].(float64) != 1 {
			t.Errorf("expected total 1, got %v", res["total"])
		}
	})

	// 5. Test GET /users/:id -> 200
	t.Run("GET /users/u1", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users/u1", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var user map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &user); err != nil {
			t.Fatalf("failed to decode user: %v", err)
		}
		if user["id"] != "u1" {
			t.Errorf("expected id u1, got %v", user["id"])
		}
	})

	// 6. Test GET /users/u999 -> 404 Not Found Problem
	t.Run("GET /users/u999 not found", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users/u999", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}
	})

	// 7. Test PATCH /users/:id -> 200
	t.Run("PATCH /users/u1", func(t *testing.T) {
		body := `{"name": "Alice Cooper"}`
		req := httptest.NewRequest("PATCH", "/users/u1", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var updated map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &updated); err != nil {
			t.Fatalf("failed to decode user: %v", err)
		}
		if updated["name"] != "Alice Cooper" {
			t.Errorf("expected name 'Alice Cooper', got %v", updated["name"])
		}
	})

	// 8. Test action POST /users/u1/actions/activate forbidden without admin scope -> 403
	t.Run("POST /users/u1/actions/activate forbidden", func(t *testing.T) {
		body := `{"reason": "Dormant user returned"}`
		req := httptest.NewRequest("POST", "/users/u1/actions/activate", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token") // only has user:write
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}
	})

	// 9. Test action POST /users/u1/actions/activate with admin scope -> 200
	t.Run("POST /users/u1/actions/activate success", func(t *testing.T) {
		body := `{"reason": "Dormant user returned"}`
		req := httptest.NewRequest("POST", "/users/u1/actions/activate", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer admin-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var res map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode user: %v", err)
		}
		if res["status"] != "active" {
			t.Errorf("expected status 'active', got %v", res["status"])
		}
	})

	// 10. Test action POST /users/u1/actions/ping (no security, no inputs) -> 200
	t.Run("POST /users/u1/actions/ping success", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/users/u1/actions/ping", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 11. Test DELETE /users/u1 -> 204
	t.Run("DELETE /users/u1", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/users/u1", nil)
		req.Header.Set("Authorization", "Bearer admin-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
		}

		// Verify deletion
		reqGet := httptest.NewRequest("GET", "/users/u1", nil)
		wGet := httptest.NewRecorder()
		r.ServeHTTP(wGet, reqGet)
		if wGet.Code != http.StatusNotFound {
			t.Fatalf("expected 404 after deletion, got %d", wGet.Code)
		}
	})
}

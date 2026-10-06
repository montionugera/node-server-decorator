package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

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

func TestHTTPServer(t *testing.T) {
	mux := http.NewServeMux()
	handler := newMockUserHandler()
	// UserSpec declares security; without an extractor those routes fail closed (401).
	allowAll := func(r *http.Request) (bool, []string, error) {
		return true, []string{"user:read", "user:write", "user:admin"}, nil
	}
	httpserver.MountRoutes(mux, example.UserSpec, handler, httpserver.WithAuth(allowAll))

	// 1. Test POST /users with invalid payload -> 400 ValidationProblem
	t.Run("POST /users invalid payload", func(t *testing.T) {
		body := `{"email": "not-an-email", "name": "A"}`
		req := httptest.NewRequest("POST", "/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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
		// Expect email, name, status, tags to be in error fields (required fields missing or invalid format/min)
		expectedFields := map[string]bool{"email": true, "name": true, "status": true, "tags": true}
		for _, f := range prob.Fields {
			delete(expectedFields, f)
		}
		if len(expectedFields) > 0 {
			t.Errorf("missing expected validation error fields: %v, got %v", expectedFields, prob.Fields)
		}
	})

	// 2. Test POST /users with valid payload -> 201 Created
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
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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
		if created["email"] != "alice@example.com" {
			t.Errorf("expected email alice@example.com, got %v", created["email"])
		}
	})

	// 3. Test GET /users -> 200 with pagination envelope
	t.Run("GET /users pagination", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users?limit=10&offset=0&status=inactive", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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
		if res["limit"].(float64) != 10 {
			t.Errorf("expected limit 10, got %v", res["limit"])
		}
		if res["offset"].(float64) != 0 {
			t.Errorf("expected offset 0, got %v", res["offset"])
		}
		items := res["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("expected 1 item, got %d", len(items))
		}
	})

	// 4. Test GET /users/u1 -> 200
	t.Run("GET /users/u1", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users/u1", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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

	// 5. Test PATCH /users/u1 -> 200
	t.Run("PATCH /users/u1", func(t *testing.T) {
		body := `{"name": "Alice Cooper"}`
		req := httptest.NewRequest("PATCH", "/users/u1", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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

	// 6. Test POST /users/u1/actions/activate -> 200
	t.Run("POST /users/u1/actions/activate", func(t *testing.T) {
		body := `{"reason": "Account verified"}`
		req := httptest.NewRequest("POST", "/users/u1/actions/activate", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

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

	// 7. Test DELETE /users/u1 -> 204
	t.Run("DELETE /users/u1", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/users/u1", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
		}

		// Verify deletion with GET
		reqGet := httptest.NewRequest("GET", "/users/u1", nil)
		wGet := httptest.NewRecorder()
		mux.ServeHTTP(wGet, reqGet)
		if wGet.Code != http.StatusNotFound {
			t.Fatalf("expected 404 after deletion, got %d", wGet.Code)
		}
	})
}

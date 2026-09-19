package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

type mockAuthEntityHandler struct {
	items map[string]map[string]any
}

func newMockAuthEntityHandler() *mockAuthEntityHandler {
	return &mockAuthEntityHandler{
		items: map[string]map[string]any{
			"m1": {"id": "m1", "name": "Alice"},
		},
	}
}

func (m *mockAuthEntityHandler) List(ctx context.Context, limit, offset int, filters map[string]string) (any, int, error) {
	var list []map[string]any
	for _, it := range m.items {
		list = append(list, it)
	}
	return list, len(list), nil
}

func (m *mockAuthEntityHandler) Get(ctx context.Context, id string) (any, error) {
	it, ok := m.items[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	return it, nil
}

func (m *mockAuthEntityHandler) Create(ctx context.Context, payload map[string]any) (any, error) {
	id := fmt.Sprintf("m%d", len(m.items)+1)
	res := make(map[string]any)
	for k, v := range payload {
		res[k] = v
	}
	res["id"] = id
	m.items[id] = res
	return res, nil
}

func (m *mockAuthEntityHandler) Update(ctx context.Context, id string, payload map[string]any) (any, error) {
	it, ok := m.items[id]
	if !ok {
		return nil, httpserver.ErrNotFound
	}
	for k, v := range payload {
		it[k] = v
	}
	return it, nil
}

func (m *mockAuthEntityHandler) Delete(ctx context.Context, id string) error {
	if _, ok := m.items[id]; !ok {
		return httpserver.ErrNotFound
	}
	delete(m.items, id)
	return nil
}

func (m *mockAuthEntityHandler) Action(ctx context.Context, id string, action string, payload map[string]any) (any, error) {
	if _, ok := m.items[id]; !ok {
		return nil, httpserver.ErrNotFound
	}
	switch action {
	case "promote":
		return map[string]any{"promoted": true}, nil
	case "ping":
		return map[string]any{"pong": true}, nil
	default:
		return nil, fmt.Errorf("unknown action: %s", action)
	}
}

func testScopeExtractor(r *http.Request) (bool, []string, error) {
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return false, nil, nil
	}
	token := strings.TrimPrefix(authHeader, "Bearer ")
	switch token {
	case "valid-read":
		return true, []string{"user:read"}, nil
	case "valid-write":
		return true, []string{"user:read", "user:write"}, nil
	case "valid-admin":
		return true, []string{"user:read", "user:write", "user:admin"}, nil
	case "valid-auth":
		return true, []string{}, nil
	default:
		return false, nil, nil
	}
}

func TestCheckScopes(t *testing.T) {
	tests := []struct {
		name        string
		required    []string
		held        []string
		wantOk      bool
		wantMissing string
	}{
		{
			name:        "empty required",
			required:    []string{},
			held:        []string{"user:read"},
			wantOk:      true,
			wantMissing: "",
		},
		{
			name:        "nil required",
			required:    nil,
			held:        []string{"user:read"},
			wantOk:      true,
			wantMissing: "",
		},
		{
			name:        "held has all required",
			required:    []string{"user:read", "user:write"},
			held:        []string{"user:read", "user:write", "user:admin"},
			wantOk:      true,
			wantMissing: "",
		},
		{
			name:        "held missing a scope",
			required:    []string{"user:read", "user:write"},
			held:        []string{"user:read"},
			wantOk:      false,
			wantMissing: "user:write",
		},
		{
			name:        "held empty",
			required:    []string{"user:admin"},
			held:        []string{},
			wantOk:      false,
			wantMissing: "user:admin",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ok, missing := httpserver.CheckScopes(tc.required, tc.held)
			if ok != tc.wantOk {
				t.Errorf("expected ok=%v, got %v", tc.wantOk, ok)
			}
			if missing != tc.wantMissing {
				t.Errorf("expected missing=%q, got %q", tc.wantMissing, missing)
			}
		})
	}
}

func TestEnforceScopeAuth_Direct(t *testing.T) {
	// Nil extractor should call next handler
	t.Run("nil extractor passes through", func(t *testing.T) {
		called := false
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		})
		handler := httpserver.EnforceScopeAuth([]string{"user:write"}, nil, next)
		req := httptest.NewRequest("POST", "/test", nil)
		w := httptest.NewRecorder()
		handler(w, req)
		if !called || w.Code != http.StatusOK {
			t.Errorf("expected next to be called with 200, got called=%v code=%d", called, w.Code)
		}
	})

	// Extractor error returns 401 Problem Details
	t.Run("extractor error returns 401", func(t *testing.T) {
		errExtractor := func(r *http.Request) (bool, []string, error) {
			return false, nil, fmt.Errorf("token expired")
		}
		handler := httpserver.EnforceScopeAuth([]string{"user:write"}, errExtractor, nil)
		req := httptest.NewRequest("POST", "/test", nil)
		w := httptest.NewRecorder()
		handler(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected content-type %q, got %q", httpserver.ProblemContentType, ct)
		}
	})
}

func TestScopedAuthorizationMiddleware(t *testing.T) {
	spec := entity.New("Member", "members").
		Fields(
			entity.Str("id", entity.ID, entity.Readonly),
			entity.Str("name"),
		).
		Ops("list", "get", "create", "delete").
		Actions(
			entity.Act("promote"),
			entity.Act("ping"),
		).
		Secure(entity.Security{
			Schemes: []entity.Scheme{{Name: "bearerAuth", Type: "http", Scheme: "bearer", BearerFormat: "JWT"}},
			Ops: map[string][]string{
				"get":    {},
				"create": {"user:write"},
				"delete": {"user:admin"},
				"list":   nil,
			},
			Actions: map[string][]string{
				"promote": {"user:admin"},
				"ping":    nil,
			},
		}).
		Build()

	handler := newMockAuthEntityHandler()
	mux := http.NewServeMux()
	httpserver.MountRoutesWithAuth(mux, spec, handler, testScopeExtractor)

	// 1. Public operation `list`: passes with no auth header (200).
	t.Run("Public operation list passes with no auth header (200)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/members", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 2. Auth-required `get`:
	//    - No auth header -> 401 Problem Details (application/problem+json, status: 401).
	//    - Valid token -> 200.
	t.Run("Auth-required get without auth header -> 401", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/members/m1", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}

		var prob httpserver.Problem
		if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
			t.Fatalf("failed to decode Problem: %v", err)
		}
		if prob.Status != 401 {
			t.Errorf("expected problem status 401, got %d", prob.Status)
		}
		if prob.Title != "Unauthorized" {
			t.Errorf("expected title 'Unauthorized', got %q", prob.Title)
		}
		if prob.Detail != "authentication required" {
			t.Errorf("expected detail 'authentication required', got %q", prob.Detail)
		}
		if prob.Instance != "/members/m1" {
			t.Errorf("expected instance '/members/m1', got %q", prob.Instance)
		}
	})

	t.Run("Auth-required get with valid token -> 200", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/members/m1", nil)
		req.Header.Set("Authorization", "Bearer valid-read")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 3. Scoped `create` (`user:write`):
	//    - No token -> 401.
	//    - Token with `user:read` -> 403 Problem Details (status: 403, detail contains missing scope).
	//    - Token with `user:write` -> 201.
	t.Run("Scoped create without token -> 401", func(t *testing.T) {
		payload := `{"name": "Bob"}`
		req := httptest.NewRequest("POST", "/members", bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("Scoped create with token having only user:read -> 403", func(t *testing.T) {
		payload := `{"name": "Bob"}`
		req := httptest.NewRequest("POST", "/members", bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer valid-read")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
			t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
		}

		var prob httpserver.Problem
		if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
			t.Fatalf("failed to decode Problem: %v", err)
		}
		if prob.Status != 403 {
			t.Errorf("expected problem status 403, got %d", prob.Status)
		}
		if prob.Title != "Forbidden" {
			t.Errorf("expected title 'Forbidden', got %q", prob.Title)
		}
		if !strings.Contains(prob.Detail, "user:write") {
			t.Errorf("expected detail to mention 'user:write', got %q", prob.Detail)
		}
		if prob.Instance != "/members" {
			t.Errorf("expected instance '/members', got %q", prob.Instance)
		}
	})

	t.Run("Scoped create with token having user:write -> 201", func(t *testing.T) {
		payload := `{"name": "Bob"}`
		req := httptest.NewRequest("POST", "/members", bytes.NewBufferString(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer valid-write")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 4. Scoped action `promote` (`user:admin`):
	//    - Token with `user:write` -> 403.
	//    - Token with `user:admin` -> 200.
	t.Run("Scoped action promote with user:write token -> 403", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/members/m1/actions/promote", nil)
		req.Header.Set("Authorization", "Bearer valid-write")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}

		var prob httpserver.Problem
		if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
			t.Fatalf("failed to decode Problem: %v", err)
		}
		if prob.Status != 403 {
			t.Errorf("expected problem status 403, got %d", prob.Status)
		}
		if !strings.Contains(prob.Detail, "user:admin") {
			t.Errorf("expected detail to mention 'user:admin', got %q", prob.Detail)
		}
	})

	t.Run("Scoped action promote with user:admin token -> 200", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/members/m1/actions/promote", nil)
		req.Header.Set("Authorization", "Bearer valid-admin")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 5. Public action `ping`: 200 without token.
	t.Run("Public action ping passes without token (200)", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/members/m1/actions/ping", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// 6. Delete operation (`user:admin`):
	//    - Token with user:write -> 403
	//    - Token with user:admin -> 204
	t.Run("Scoped delete with user:write -> 403", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/members/m1", nil)
		req.Header.Set("Authorization", "Bearer valid-write")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("Scoped delete with user:admin -> 204", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/members/m1", nil)
		req.Header.Set("Authorization", "Bearer valid-admin")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
		}
	})
}

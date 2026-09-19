package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

func TestExampleE2E(t *testing.T) {
	store := newStore()
	r := setupRouter(store)

	// Step 1: Direct Gin ShouldBindJSON test with UserCreateDTO binding tags
	t.Run("Direct Gin DTO binding - invalid email rejected by Gin validator", func(t *testing.T) {
		body := `{"email": "not-an-email", "name": "Bob", "status": "active", "tags": ["tag1"]}`
		req := httptest.NewRequest("POST", "/api/direct-bind/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != 422 {
			t.Fatalf("expected 422 Unprocessable Entity from gin validator, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("Direct Gin DTO binding - valid payload accepted", func(t *testing.T) {
		body := `{"email": "bob@example.com", "name": "Bob", "status": "active", "tags": ["tag1"]}`
		req := httptest.NewRequest("POST", "/api/direct-bind/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
		}
	})

	// Step 2: EntitySpec route mounting - Create User with auth
	t.Run("EntitySpec POST /users unauthenticated returns 401 Problem Details", func(t *testing.T) {
		body := `{"email": "alice@example.com", "name": "Alice", "status": "inactive", "tags": ["dev"]}`
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

	t.Run("EntitySpec POST /users authenticated creates user u1", func(t *testing.T) {
		body := `{"email": "alice@example.com", "name": "Alice", "status": "inactive", "tags": ["dev"]}`
		req := httptest.NewRequest("POST", "/users", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got %d: %s", w.Code, w.Body.String())
		}

		var created map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &created)
		if created["id"] != "u1" {
			t.Fatalf("expected id u1, got %v", created["id"])
		}
	})

	// Step 3: GET /users/u1
	t.Run("EntitySpec GET /users/u1 returns user", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/users/u1", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	// Step 4: Action POST /users/u1/actions/activate
	t.Run("EntitySpec Action activate requires user:admin scope (403 on write-token)", func(t *testing.T) {
		body := `{"reason": "re-activated"}`
		req := httptest.NewRequest("POST", "/users/u1/actions/activate", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer write-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("EntitySpec Action activate succeeds with admin-token (200 OK)", func(t *testing.T) {
		body := `{"reason": "re-activated"}`
		req := httptest.NewRequest("POST", "/users/u1/actions/activate", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer admin-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
		}

		var res map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &res)
		if res["status"] != "active" {
			t.Errorf("expected status 'active', got %v", res["status"])
		}
	})

	// Step 5: DELETE /users/u1
	t.Run("EntitySpec DELETE /users/u1 with admin-token succeeds (204 No Content)", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/users/u1", nil)
		req.Header.Set("Authorization", "Bearer admin-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204 No Content, got %d: %s", w.Code, w.Body.String())
		}

		// Verify 404 after deletion
		reqGet := httptest.NewRequest("GET", "/users/u1", nil)
		wGet := httptest.NewRecorder()
		r.ServeHTTP(wGet, reqGet)
		if wGet.Code != http.StatusNotFound {
			t.Fatalf("expected 404 after deletion, got %d", wGet.Code)
		}
	})
}

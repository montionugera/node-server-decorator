package ginadapter_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	ginadapter "github.com/montionugera/node-server-decorator/v2/go/adapter/gin"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestEnforceScopeAuth(t *testing.T) {
	tests := []struct {
		name           string
		requiredScopes []string
		extractor      ginadapter.ScopeExtractor
		wantStatus     int
		wantBodySub    string
		wantExecuted   bool
	}{
		{
			name:           "no extractor passes through",
			requiredScopes: []string{"read"},
			extractor:      nil,
			wantStatus:     http.StatusOK,
			wantExecuted:   true,
		},
		{
			name:           "unauthenticated returns 401 and aborts",
			requiredScopes: []string{"read"},
			extractor: func(c *gin.Context) (bool, []string, error) {
				return false, nil, nil
			},
			wantStatus:   http.StatusUnauthorized,
			wantBodySub:  "authentication required",
			wantExecuted: false,
		},
		{
			name:           "extractor error returns 401 and aborts",
			requiredScopes: []string{"read"},
			extractor: func(c *gin.Context) (bool, []string, error) {
				return true, nil, errors.New("token expired")
			},
			wantStatus:   http.StatusUnauthorized,
			wantBodySub:  "authentication required",
			wantExecuted: false,
		},
		{
			name:           "missing required scope returns 403 and aborts",
			requiredScopes: []string{"user:write", "user:admin"},
			extractor: func(c *gin.Context) (bool, []string, error) {
				return true, []string{"user:write"}, nil
			},
			wantStatus:   http.StatusForbidden,
			wantBodySub:  "missing required scope: user:admin",
			wantExecuted: false,
		},
		{
			name:           "valid scopes returns 200 and executes next",
			requiredScopes: []string{"user:write"},
			extractor: func(c *gin.Context) (bool, []string, error) {
				return true, []string{"user:write", "user:read"}, nil
			},
			wantStatus:   http.StatusOK,
			wantExecuted: true,
		},
		{
			name:           "empty required scopes allows authenticated caller",
			requiredScopes: []string{},
			extractor: func(c *gin.Context) (bool, []string, error) {
				return true, []string{}, nil
			},
			wantStatus:   http.StatusOK,
			wantExecuted: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := gin.New()
			var executed bool
			r.GET("/test", ginadapter.EnforceScopeAuth(tc.requiredScopes, tc.extractor), func(c *gin.Context) {
				executed = true
				c.Status(http.StatusOK)
			})

			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/test", nil)
			r.ServeHTTP(w, req)

			if w.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.wantStatus, w.Code, w.Body.String())
			}
			if executed != tc.wantExecuted {
				t.Errorf("expected executed=%v, got %v", tc.wantExecuted, executed)
			}
			if tc.wantStatus != http.StatusOK {
				// Verify Content-Type is preserved as application/problem+json
				if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
					t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
				}
				var prob httpserver.Problem
				if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
					t.Fatalf("failed to decode Problem: %v", err)
				}
				if prob.Status != tc.wantStatus {
					t.Errorf("expected prob.Status %d, got %d", tc.wantStatus, prob.Status)
				}
				if tc.wantBodySub != "" && prob.Detail != tc.wantBodySub {
					t.Errorf("expected detail %q, got %q", tc.wantBodySub, prob.Detail)
				}
			}
		})
	}
}

func TestWriteValidationProblem(t *testing.T) {
	r := gin.New()
	r.POST("/validate", func(c *gin.Context) {
		ginadapter.WriteValidationProblem(c, []string{"name", "email"})
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/validate", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
		t.Errorf("expected Content-Type %q, got %q", httpserver.ProblemContentType, ct)
	}

	var prob httpserver.ValidationProblem
	if err := json.Unmarshal(w.Body.Bytes(), &prob); err != nil {
		t.Fatalf("failed to unmarshal ValidationProblem: %v", err)
	}
	if prob.Type != httpserver.ValidationProblemType {
		t.Errorf("expected type %q, got %q", httpserver.ValidationProblemType, prob.Type)
	}
	if len(prob.Fields) != 2 || prob.Fields[0] != "name" || prob.Fields[1] != "email" {
		t.Errorf("unexpected fields: %v", prob.Fields)
	}
}

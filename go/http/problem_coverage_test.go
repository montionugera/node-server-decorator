package httpserver_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

func problemCovDecode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	return body
}

func TestProblemCoverage_WriteProblemDefaultsTitleToStatusText(t *testing.T) {
	rec := httptest.NewRecorder()
	httpserver.WriteProblem(rec, http.StatusNotFound, "", "", "")

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q", ct)
	}
	want := map[string]any{"type": "about:blank", "title": "Not Found", "status": float64(404)}
	if got := problemCovDecode(t, rec); !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v (empty detail/instance must be omitted)", got, want)
	}
}

func TestProblemCoverage_WriteProblemKeepsExplicitFields(t *testing.T) {
	rec := httptest.NewRecorder()
	httpserver.WriteProblem(rec, http.StatusConflict, "State Conflict", "already active", "/users/42")

	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409", rec.Code)
	}
	want := map[string]any{
		"type":     "about:blank",
		"title":    "State Conflict",
		"status":   float64(409),
		"detail":   "already active",
		"instance": "/users/42",
	}
	if got := problemCovDecode(t, rec); !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v", got, want)
	}
}

func TestProblemCoverage_WriteProblemUnknownStatusHasEmptyTitle(t *testing.T) {
	rec := httptest.NewRecorder()
	httpserver.WriteProblem(rec, 599, "", "", "")

	if rec.Code != 599 {
		t.Errorf("status = %d, want 599", rec.Code)
	}
	body := problemCovDecode(t, rec)
	if title, ok := body["title"]; !ok || title != "" {
		t.Errorf("title = %v (present=%v), want an empty but present title", title, ok)
	}
	if body["status"] != float64(599) {
		t.Errorf("status member = %v, want 599", body["status"])
	}
}

func TestProblemCoverage_WriteValidationProblemNilFieldsEncodeAsEmptyArray(t *testing.T) {
	rec := httptest.NewRecorder()
	httpserver.WriteValidationProblem(rec, nil, "")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
		t.Errorf("Content-Type = %q", ct)
	}
	want := map[string]any{
		"type":   httpserver.ValidationProblemType,
		"title":  "Validation Failed",
		"status": float64(400),
		"fields": []any{},
	}
	if got := problemCovDecode(t, rec); !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v (fields must be [] rather than null)", got, want)
	}
}

func TestProblemCoverage_WriteValidationProblemListsFieldsInOrder(t *testing.T) {
	rec := httptest.NewRecorder()
	httpserver.WriteValidationProblem(rec, []string{"email", "profile.bio"}, "/users")

	body := problemCovDecode(t, rec)
	if !reflect.DeepEqual(body["fields"], []any{"email", "profile.bio"}) {
		t.Errorf("fields = %v", body["fields"])
	}
	if body["instance"] != "/users" {
		t.Errorf("instance = %v, want /users", body["instance"])
	}
	if _, ok := body["detail"]; ok {
		t.Errorf("detail must be omitted, got %v", body["detail"])
	}
}

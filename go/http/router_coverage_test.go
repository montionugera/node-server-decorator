package httpserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

// covHandler is an EntityHandler fake: it records what the router passed in and returns
// whatever the test configured.
type covHandler struct {
	calls []string

	listLimit, listOffset int
	listFilters           map[string]string
	gotID, gotAction      string
	gotPayload            map[string]any

	items any
	total int
	res   any
	err   error
}

func (h *covHandler) List(_ context.Context, limit, offset int, filters map[string]string) (any, int, error) {
	h.calls = append(h.calls, "list")
	h.listLimit, h.listOffset, h.listFilters = limit, offset, filters
	return h.items, h.total, h.err
}

func (h *covHandler) Get(_ context.Context, id string) (any, error) {
	h.calls = append(h.calls, "get")
	h.gotID = id
	return h.res, h.err
}

func (h *covHandler) Create(_ context.Context, payload map[string]any) (any, error) {
	h.calls = append(h.calls, "create")
	h.gotPayload = payload
	return h.res, h.err
}

func (h *covHandler) Update(_ context.Context, id string, payload map[string]any) (any, error) {
	h.calls = append(h.calls, "update")
	h.gotID, h.gotPayload = id, payload
	return h.res, h.err
}

func (h *covHandler) Delete(_ context.Context, id string) error {
	h.calls = append(h.calls, "delete")
	h.gotID = id
	return h.err
}

func (h *covHandler) Action(_ context.Context, id, action string, payload map[string]any) (any, error) {
	h.calls = append(h.calls, "action")
	h.gotID, h.gotAction, h.gotPayload = id, action, payload
	return h.res, h.err
}

func covInt(i int) *int { return &i }

func covWidgetSpec() entity.Spec {
	return entity.Spec{
		Entity: "Widget",
		Path:   "/widgets/", // surrounding slashes must be normalised
		Ops:    []string{"list", "get", "create", "update", "delete"},
		Fields: []entity.Field{
			{Name: "slug", Type: "str", Role: "id", Readonly: true},
			{Name: "name", Type: "str", Min: covInt(2)},
			{Name: "kind", Type: "enum", Enum: []string{"a", "b"}, Filterable: true, Optional: true},
			{Name: "owner", Type: "str", Filterable: true, Optional: true},
		},
		Actions: []entity.Action{
			{Name: "rename", Input: []entity.Field{{Name: "to", Type: "str", Min: covInt(1)}}},
			{Name: "touch", Input: []entity.Field{{Name: "note", Type: "str", Optional: true}}},
			{Name: "ping"},
		},
	}
}

type covProblem struct {
	Type     string   `json:"type"`
	Title    string   `json:"title"`
	Status   int      `json:"status"`
	Detail   string   `json:"detail"`
	Instance string   `json:"instance"`
	Fields   []string `json:"fields"`
}

func covServe(spec entity.Spec, h httpserver.EntityHandler, method, target, body string, opts ...httpserver.RouterOption) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	httpserver.MountRoutes(mux, spec, h, opts...)
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func covWantProblem(t *testing.T, rec *httptest.ResponseRecorder, status int, title, detail, instance string) covProblem {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != httpserver.ProblemContentType {
		t.Fatalf("Content-Type = %q, want %q", ct, httpserver.ProblemContentType)
	}
	var p covProblem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("problem body is not JSON: %v", err)
	}
	if p.Status != status || p.Title != title || p.Detail != detail || p.Instance != instance {
		t.Fatalf("problem = %+v, want status=%d title=%q detail=%q instance=%q", p, status, title, detail, instance)
	}
	return p
}

func covWantValidation(t *testing.T, rec *httptest.ResponseRecorder, instance string, fields ...string) {
	t.Helper()
	p := covWantProblem(t, rec, http.StatusBadRequest, "Validation Failed", "", instance)
	if p.Type != httpserver.ValidationProblemType {
		t.Fatalf("problem type = %q, want the validation type", p.Type)
	}
	if !reflect.DeepEqual(p.Fields, fields) {
		t.Fatalf("fields = %v, want %v", p.Fields, fields)
	}
}

func covWantJSON(t *testing.T, rec *httptest.ResponseRecorder, status int, want string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestRouterCoverage_ListPaginationParsing(t *testing.T) {
	for _, tc := range []struct {
		query               string
		wantLimit, wantOffs int
	}{
		{"", 20, 0},
		{"?limit=0&offset=0", 0, 0},
		{"?limit=100&offset=5", 100, 5},
		{"?limit=101", 100, 0},
		{"?limit=500&offset=7", 100, 7},
		{"?limit=-1&offset=-3", 20, 0},
		{"?limit=abc&offset=x", 20, 0},
		{"?limit=1.5&offset=2.5", 20, 0},
		{"?limit=99999999999999999999&offset=99999999999999999999", 20, 0}, // int overflow
	} {
		t.Run(tc.query, func(t *testing.T) {
			h := &covHandler{items: []string{"w"}, total: 41}
			rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets"+tc.query, "")
			if h.listLimit != tc.wantLimit || h.listOffset != tc.wantOffs {
				t.Fatalf("handler got limit=%d offset=%d, want %d/%d", h.listLimit, h.listOffset, tc.wantLimit, tc.wantOffs)
			}
			covWantJSON(t, rec, http.StatusOK,
				fmt.Sprintf(`{"items":["w"],"limit":%d,"offset":%d,"total":41}`, tc.wantLimit, tc.wantOffs))
		})
	}
}

func TestRouterCoverage_ListPassesOnlyFilterableFields(t *testing.T) {
	h := &covHandler{}
	rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets?kind=a&owner=&name=zz&slug=s1&bogus=1", "")
	if want := map[string]string{"kind": "a"}; !reflect.DeepEqual(h.listFilters, want) {
		t.Fatalf("filters = %v, want %v (non-filterable, unknown and empty params dropped)", h.listFilters, want)
	}
	// A nil item list is serialised as [] so clients never see null.
	covWantJSON(t, rec, http.StatusOK, `{"items":[],"limit":20,"offset":0,"total":0}`)
}

func TestRouterCoverage_ListHandlerError(t *testing.T) {
	h := &covHandler{err: errors.New("db down")}
	rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets", "")
	covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "db down", "/widgets")
}

func TestRouterCoverage_Get(t *testing.T) {
	t.Run("ok uses the id-role field as path parameter", func(t *testing.T) {
		h := &covHandler{res: map[string]any{"slug": "s1"}}
		rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets/s1", "")
		covWantJSON(t, rec, http.StatusOK, `{"slug":"s1"}`)
		if h.gotID != "s1" {
			t.Fatalf("handler got id %q, want s1", h.gotID)
		}
	})
	t.Run("wrapped ErrNotFound is 404", func(t *testing.T) {
		h := &covHandler{err: fmt.Errorf("repo: %w", httpserver.ErrNotFound)}
		rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets/s1", "")
		covWantProblem(t, rec, http.StatusNotFound, "Not Found", "entity with id s1 not found", "/widgets/s1")
	})
	t.Run("nil result is 404", func(t *testing.T) {
		rec := covServe(covWidgetSpec(), &covHandler{}, http.MethodGet, "/widgets/s2", "")
		covWantProblem(t, rec, http.StatusNotFound, "Not Found", "entity with id s2 not found", "/widgets/s2")
	})
	t.Run("other error is 500", func(t *testing.T) {
		h := &covHandler{err: errors.New("boom")}
		rec := covServe(covWidgetSpec(), h, http.MethodGet, "/widgets/s1", "")
		covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "boom", "/widgets/s1")
	})
}

func TestRouterCoverage_Create(t *testing.T) {
	t.Run("created", func(t *testing.T) {
		h := &covHandler{res: map[string]any{"slug": "new"}}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, "/widgets", `{"name":"ab","kind":"b"}`)
		covWantJSON(t, rec, http.StatusCreated, `{"slug":"new"}`)
		if want := map[string]any{"name": "ab", "kind": "b"}; !reflect.DeepEqual(h.gotPayload, want) {
			t.Fatalf("payload = %v, want %v", h.gotPayload, want)
		}
	})
	for name, body := range map[string]string{
		"malformed json": `{"name":`,
		"empty body":     ``,
		"json array":     `[1,2]`,
		"json string":    `"x"`,
	} {
		t.Run(name+" is a _body validation problem", func(t *testing.T) {
			h := &covHandler{}
			rec := covServe(covWidgetSpec(), h, http.MethodPost, "/widgets", body)
			covWantValidation(t, rec, "/widgets", "_body")
			if len(h.calls) != 0 {
				t.Fatalf("handler was called for an undecodable body: %v", h.calls)
			}
		})
	}
	t.Run("validation failure lists sorted fields and skips the handler", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, "/widgets", `{"slug":"x","name":"a","kind":"zzz"}`)
		covWantValidation(t, rec, "/widgets", "kind", "name", "slug")
		if len(h.calls) != 0 {
			t.Fatalf("handler was called despite validation errors: %v", h.calls)
		}
	})
	t.Run("json null body fails validation at the root", func(t *testing.T) {
		rec := covServe(covWidgetSpec(), &covHandler{}, http.MethodPost, "/widgets", `null`)
		covWantValidation(t, rec, "/widgets", "name")
	})
	t.Run("handler error is 500", func(t *testing.T) {
		h := &covHandler{err: errors.New("unique violation")}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, "/widgets", `{"name":"ab"}`)
		covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "unique violation", "/widgets")
	})
}

func TestRouterCoverage_Update(t *testing.T) {
	t.Run("ok is a partial update", func(t *testing.T) {
		h := &covHandler{res: map[string]any{"ok": true}}
		rec := covServe(covWidgetSpec(), h, http.MethodPatch, "/widgets/s1", `{"kind":"a"}`)
		covWantJSON(t, rec, http.StatusOK, `{"ok":true}`)
		if h.gotID != "s1" || !reflect.DeepEqual(h.gotPayload, map[string]any{"kind": "a"}) {
			t.Fatalf("handler got id=%q payload=%v", h.gotID, h.gotPayload)
		}
	})
	t.Run("malformed body", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodPatch, "/widgets/s1", `{`)
		covWantValidation(t, rec, "/widgets/s1", "_body")
		if len(h.calls) != 0 {
			t.Fatalf("handler was called: %v", h.calls)
		}
	})
	t.Run("validation failure", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodPatch, "/widgets/s1", `{"name":"a","slug":"nope"}`)
		covWantValidation(t, rec, "/widgets/s1", "name", "slug")
		if len(h.calls) != 0 {
			t.Fatalf("handler was called: %v", h.calls)
		}
	})
	t.Run("not found", func(t *testing.T) {
		h := &covHandler{err: httpserver.ErrNotFound}
		rec := covServe(covWidgetSpec(), h, http.MethodPatch, "/widgets/gone", `{}`)
		covWantProblem(t, rec, http.StatusNotFound, "Not Found", "entity with id gone not found", "/widgets/gone")
	})
	t.Run("other error", func(t *testing.T) {
		h := &covHandler{err: errors.New("conflict")}
		rec := covServe(covWidgetSpec(), h, http.MethodPatch, "/widgets/s1", `{}`)
		covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "conflict", "/widgets/s1")
	})
}

func TestRouterCoverage_Delete(t *testing.T) {
	t.Run("no content", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodDelete, "/widgets/s1", "")
		if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
			t.Fatalf("got %d with body %q, want 204 and no body", rec.Code, rec.Body.String())
		}
		if h.gotID != "s1" {
			t.Fatalf("handler got id %q", h.gotID)
		}
	})
	t.Run("not found", func(t *testing.T) {
		h := &covHandler{err: httpserver.ErrNotFound}
		rec := covServe(covWidgetSpec(), h, http.MethodDelete, "/widgets/s1", "")
		covWantProblem(t, rec, http.StatusNotFound, "Not Found", "entity with id s1 not found", "/widgets/s1")
	})
	t.Run("other error", func(t *testing.T) {
		h := &covHandler{err: errors.New("fk constraint")}
		rec := covServe(covWidgetSpec(), h, http.MethodDelete, "/widgets/s1", "")
		covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "fk constraint", "/widgets/s1")
	})
}

func TestRouterCoverage_ActionWithInput(t *testing.T) {
	const path = "/widgets/s1/actions/rename"
	t.Run("ok", func(t *testing.T) {
		h := &covHandler{res: map[string]any{"renamed": true}}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, path, `{"to":"n"}`)
		covWantJSON(t, rec, http.StatusOK, `{"renamed":true}`)
		if h.gotID != "s1" || h.gotAction != "rename" || !reflect.DeepEqual(h.gotPayload, map[string]any{"to": "n"}) {
			t.Fatalf("handler got id=%q action=%q payload=%v", h.gotID, h.gotAction, h.gotPayload)
		}
	})
	t.Run("empty body is treated as {} and still validated", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, path, "")
		covWantValidation(t, rec, path, "to")
		if len(h.calls) != 0 {
			t.Fatalf("handler was called: %v", h.calls)
		}
	})
	t.Run("empty body passes when every input is optional", func(t *testing.T) {
		h := &covHandler{res: "ok"}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, "/widgets/s1/actions/touch", "")
		covWantJSON(t, rec, http.StatusOK, `"ok"`)
		if h.gotPayload == nil || len(h.gotPayload) != 0 {
			t.Fatalf("payload = %#v, want an empty non-nil map", h.gotPayload)
		}
	})
	t.Run("malformed body", func(t *testing.T) {
		h := &covHandler{}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, path, `{"to":`)
		covWantValidation(t, rec, path, "_body")
		if len(h.calls) != 0 {
			t.Fatalf("handler was called: %v", h.calls)
		}
	})
	t.Run("validation failure", func(t *testing.T) {
		rec := covServe(covWidgetSpec(), &covHandler{}, http.MethodPost, path, `{"to":"","extra":1}`)
		covWantValidation(t, rec, path, "extra", "to")
	})
	t.Run("not found", func(t *testing.T) {
		h := &covHandler{err: httpserver.ErrNotFound}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, path, `{"to":"n"}`)
		covWantProblem(t, rec, http.StatusNotFound, "Not Found", "entity with id s1 not found", path)
	})
	t.Run("other error", func(t *testing.T) {
		h := &covHandler{err: errors.New("locked")}
		rec := covServe(covWidgetSpec(), h, http.MethodPost, path, `{"to":"n"}`)
		covWantProblem(t, rec, http.StatusInternalServerError, "Internal Server Error", "locked", path)
	})
}

func TestRouterCoverage_ActionWithoutInput(t *testing.T) {
	const path = "/widgets/s9/actions/ping"
	for name, body := range map[string]string{"no body": "", "garbage body": "{not json"} {
		t.Run(name, func(t *testing.T) {
			h := &covHandler{res: map[string]any{"pong": true}}
			rec := covServe(covWidgetSpec(), h, http.MethodPost, path, body)
			covWantJSON(t, rec, http.StatusOK, `{"pong":true}`)
			if h.gotID != "s9" || h.gotAction != "ping" {
				t.Fatalf("handler got id=%q action=%q", h.gotID, h.gotAction)
			}
			if h.gotPayload == nil || len(h.gotPayload) != 0 {
				t.Fatalf("payload = %#v, want an empty non-nil map", h.gotPayload)
			}
		})
	}
	t.Run("a supplied object is passed through", func(t *testing.T) {
		h := &covHandler{res: 1}
		covServe(covWidgetSpec(), h, http.MethodPost, path, `{"trace":"t1"}`)
		if !reflect.DeepEqual(h.gotPayload, map[string]any{"trace": "t1"}) {
			t.Fatalf("payload = %v", h.gotPayload)
		}
	})
}

func TestRouterCoverage_OnlyDeclaredOpsAreMounted(t *testing.T) {
	spec := covWidgetSpec()
	spec.Ops = []string{"list", "bogus"}
	spec.Actions = nil
	spec.Fields = spec.Fields[1:] // no id-role field: the path parameter falls back to "id"

	h := &covHandler{}
	if rec := covServe(spec, h, http.MethodGet, "/widgets/s1", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET item without the get op = %d, want 404", rec.Code)
	}
	if rec := covServe(spec, h, http.MethodPost, "/widgets", `{"name":"ab"}`); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST without the create op = %d, want 405", rec.Code)
	}
	if len(h.calls) != 0 {
		t.Fatalf("handler reached through an undeclared op: %v", h.calls)
	}
	if rec := covServe(spec, h, http.MethodGet, "/widgets", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("declared list op = %d, want 200", rec.Code)
	}

	// With "get" declared and no id-role field, the {id} parameter is used.
	spec.Ops = []string{"get"}
	h = &covHandler{res: "v"}
	if rec := covServe(spec, h, http.MethodGet, "/widgets/abc", ""); rec.Code != http.StatusOK || h.gotID != "abc" {
		t.Fatalf("fallback id param: status=%d id=%q, want 200/abc", rec.Code, h.gotID)
	}
}

func TestRouterCoverage_DeclaredSecurityGatesOpsAndActions(t *testing.T) {
	spec := covWidgetSpec()
	spec.Security = &entity.Security{
		Ops:     map[string][]string{"delete": {"w:admin"}, "get": {}, "list": nil},
		Actions: map[string][]string{"ping": {"w:ping"}, "touch": nil},
	}
	extractor := func(scopes ...string) httpserver.ScopeExtractor {
		return func(r *http.Request) (bool, []string, error) {
			return r.Header.Get("Authorization") != "", scopes, nil
		}
	}
	serve := func(h *covHandler, ext httpserver.ScopeExtractor, method, target string, authed bool) *httptest.ResponseRecorder {
		mux := http.NewServeMux()
		if ext == nil {
			httpserver.MountRoutes(mux, spec, h)
		} else {
			httpserver.MountRoutesWithAuth(mux, spec, h, ext)
		}
		req := httptest.NewRequest(method, target, nil)
		if authed {
			req.Header.Set("Authorization", "Bearer t")
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	t.Run("secured op without an extractor fails closed", func(t *testing.T) {
		h := &covHandler{}
		rec := serve(h, nil, http.MethodDelete, "/widgets/s1", true)
		covWantProblem(t, rec, http.StatusUnauthorized, "Unauthorized", "authentication required", "/widgets/s1")
		if len(h.calls) != 0 {
			t.Fatalf("handler reached: %v", h.calls)
		}
	})
	t.Run("missing scope is 403", func(t *testing.T) {
		h := &covHandler{}
		rec := serve(h, extractor("w:read"), http.MethodDelete, "/widgets/s1", true)
		covWantProblem(t, rec, http.StatusForbidden, "Forbidden", "missing required scope: w:admin", "/widgets/s1")
		if len(h.calls) != 0 {
			t.Fatalf("handler reached: %v", h.calls)
		}
	})
	t.Run("held scope reaches the handler", func(t *testing.T) {
		h := &covHandler{}
		if rec := serve(h, extractor("w:admin"), http.MethodDelete, "/widgets/s1", true); rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", rec.Code)
		}
		if !reflect.DeepEqual(h.calls, []string{"delete"}) {
			t.Fatalf("calls = %v", h.calls)
		}
	})
	t.Run("empty scope list still requires authentication", func(t *testing.T) {
		h := &covHandler{res: "v"}
		if rec := serve(h, extractor(), http.MethodGet, "/widgets/s1", false); rec.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous status = %d, want 401", rec.Code)
		}
		if rec := serve(h, extractor(), http.MethodGet, "/widgets/s1", true); rec.Code != http.StatusOK {
			t.Fatalf("authenticated status = %d, want 200", rec.Code)
		}
	})
	t.Run("nil scope entry and undeclared ops stay public", func(t *testing.T) {
		h := &covHandler{}
		if rec := serve(h, extractor(), http.MethodGet, "/widgets", false); rec.Code != http.StatusOK {
			t.Fatalf("list status = %d, want 200", rec.Code)
		}
		h = &covHandler{res: "ok"}
		if rec := serve(h, extractor(), http.MethodPost, "/widgets/s1/actions/touch", false); rec.Code != http.StatusOK {
			t.Fatalf("touch status = %d, want 200", rec.Code)
		}
	})
	t.Run("secured action", func(t *testing.T) {
		h := &covHandler{res: "pong"}
		rec := serve(h, extractor("w:admin"), http.MethodPost, "/widgets/s1/actions/ping", true)
		covWantProblem(t, rec, http.StatusForbidden, "Forbidden", "missing required scope: w:ping", "/widgets/s1/actions/ping")
		if len(h.calls) != 0 {
			t.Fatalf("handler reached: %v", h.calls)
		}
		if rec := serve(h, extractor("w:ping"), http.MethodPost, "/widgets/s1/actions/ping", true); rec.Code != http.StatusOK {
			t.Fatalf("status with scope = %d, want 200", rec.Code)
		}
		if h.gotAction != "ping" {
			t.Fatalf("action = %q", h.gotAction)
		}
	})
}

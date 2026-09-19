package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

// ErrNotFound indicates an entity was not found.
var ErrNotFound = errors.New("not found")

// EntityHandler defines the CRUD and Action interface for handling entity requests.
type EntityHandler interface {
	List(ctx context.Context, limit, offset int, filters map[string]string) (any, int, error)
	Get(ctx context.Context, id string) (any, error)
	Create(ctx context.Context, payload map[string]any) (any, error)
	Update(ctx context.Context, id string, payload map[string]any) (any, error)
	Delete(ctx context.Context, id string) error
	Action(ctx context.Context, id string, action string, payload map[string]any) (any, error)
}

// MountRoutes mounts routes on an http.ServeMux for the given EntitySpec and EntityHandler.
func MountRoutes(mux *http.ServeMux, spec entity.Spec, handler EntityHandler) {
	idField := "id"
	for _, f := range spec.Fields {
		if f.Role == "id" {
			idField = f.Name
			break
		}
	}

	// Clean path to ensure standard format without leading/trailing slashes
	basePath := "/" + strings.Trim(spec.Path, "/")
	itemPath := basePath + "/{" + idField + "}"

	// Map filterable fields for list operation
	filterableFields := make(map[string]struct{})
	for _, f := range spec.Fields {
		if f.Filterable {
			filterableFields[f.Name] = struct{}{}
		}
	}

	for _, op := range spec.Ops {
		switch op {
		case "list":
			mux.HandleFunc("GET "+basePath, func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()

				limit := 20
				if lStr := q.Get("limit"); lStr != "" {
					if val, err := strconv.Atoi(lStr); err == nil && val >= 0 {
						if val > 100 {
							val = 100
						}
						limit = val
					}
				}

				offset := 0
				if oStr := q.Get("offset"); oStr != "" {
					if val, err := strconv.Atoi(oStr); err == nil && val >= 0 {
						offset = val
					}
				}

				filters := make(map[string]string)
				for name := range filterableFields {
					if val := q.Get(name); val != "" {
						filters[name] = val
					}
				}

				items, total, err := handler.List(r.Context(), limit, offset, filters)
				if err != nil {
					WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
					return
				}

				if items == nil {
					items = []any{}
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"items":  items,
					"total":  total,
					"limit":  limit,
					"offset": offset,
				})
			})

		case "get":
			mux.HandleFunc("GET "+itemPath, func(w http.ResponseWriter, r *http.Request) {
				id := r.PathValue(idField)
				res, err := handler.Get(r.Context(), id)
				if err != nil {
					if errors.Is(err, ErrNotFound) {
						WriteProblem(w, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id), r.URL.Path)
						return
					}
					WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
					return
				}
				if res == nil {
					WriteProblem(w, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id), r.URL.Path)
					return
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(res)
			})

		case "create":
			mux.HandleFunc("POST "+basePath, func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				dec := json.NewDecoder(r.Body)
				if err := dec.Decode(&body); err != nil {
					WriteValidationProblem(w, []string{"_body"}, r.URL.Path)
					return
				}

				if fields, ok := dto.Validate(spec, "create", body); !ok {
					WriteValidationProblem(w, fields, r.URL.Path)
					return
				}

				res, err := handler.Create(r.Context(), body)
				if err != nil {
					WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
					return
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(res)
			})

		case "update":
			mux.HandleFunc("PATCH "+itemPath, func(w http.ResponseWriter, r *http.Request) {
				id := r.PathValue(idField)

				var body map[string]any
				dec := json.NewDecoder(r.Body)
				if err := dec.Decode(&body); err != nil {
					WriteValidationProblem(w, []string{"_body"}, r.URL.Path)
					return
				}

				if fields, ok := dto.Validate(spec, "update", body); !ok {
					WriteValidationProblem(w, fields, r.URL.Path)
					return
				}

				res, err := handler.Update(r.Context(), id, body)
				if err != nil {
					if errors.Is(err, ErrNotFound) {
						WriteProblem(w, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id), r.URL.Path)
						return
					}
					WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
					return
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(res)
			})

		case "delete":
			mux.HandleFunc("DELETE "+itemPath, func(w http.ResponseWriter, r *http.Request) {
				id := r.PathValue(idField)
				if err := handler.Delete(r.Context(), id); err != nil {
					if errors.Is(err, ErrNotFound) {
						WriteProblem(w, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id), r.URL.Path)
						return
					}
					WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
		}
	}

	for _, act := range spec.Actions {
		action := act
		actionRoute := "POST " + itemPath + "/actions/" + action.Name
		mux.HandleFunc(actionRoute, func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue(idField)

			var body map[string]any
			if len(action.Input) > 0 {
				dec := json.NewDecoder(r.Body)
				if err := dec.Decode(&body); err != nil {
					if errors.Is(err, io.EOF) {
						body = make(map[string]any)
					} else {
						WriteValidationProblem(w, []string{"_body"}, r.URL.Path)
						return
					}
				}

				if fields, ok := dto.Validate(spec, "action:"+action.Name, body); !ok {
					WriteValidationProblem(w, fields, r.URL.Path)
					return
				}
			} else {
				// Action has no inputs, payload can be empty or optional body
				dec := json.NewDecoder(r.Body)
				_ = dec.Decode(&body)
				if body == nil {
					body = make(map[string]any)
				}
			}

			res, err := handler.Action(r.Context(), id, action.Name, body)
			if err != nil {
				if errors.Is(err, ErrNotFound) {
					WriteProblem(w, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id), r.URL.Path)
					return
				}
				WriteProblem(w, http.StatusInternalServerError, "", err.Error(), r.URL.Path)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(res)
		})
	}
}

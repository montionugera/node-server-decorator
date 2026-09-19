package ginadapter

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/montionugera/node-server-decorator/v2/go/dto"
	"github.com/montionugera/node-server-decorator/v2/go/entity"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

var pathParamRegex = regexp.MustCompile(`\{([a-zA-Z0-9_]+)\}`)

// ToGinPath converts standard OpenAPI/Go 1.22 path format (e.g. "/users/{id}")
// to Gin format (e.g. "/users/:id").
func ToGinPath(path string) string {
	return pathParamRegex.ReplaceAllString(path, ":$1")
}

type routerConfig struct {
	authExtractor ScopeExtractor
}

// RouterOption configures route mounting options.
type RouterOption func(*routerConfig)

// WithAuth configures a ScopeExtractor for declarative scope authorization.
func WithAuth(extractor ScopeExtractor) RouterOption {
	return func(cfg *routerConfig) {
		cfg.authExtractor = extractor
	}
}

// MountRoutes mounts CRUD and Action routes for the given entity.Spec on a Gin router.
func MountRoutes(router gin.IRoutes, spec entity.Spec, handler httpserver.EntityHandler, opts ...RouterOption) {
	var cfg routerConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	idField := "id"
	for _, f := range spec.Fields {
		if f.Role == "id" {
			idField = f.Name
			break
		}
	}

	basePath := "/" + strings.Trim(spec.Path, "/")
	itemPath := basePath + "/:" + idField

	filterableFields := make(map[string]struct{})
	for _, f := range spec.Fields {
		if f.Filterable {
			filterableFields[f.Name] = struct{}{}
		}
	}

	for _, op := range spec.Ops {
		var h gin.HandlerFunc
		var method string
		var routePath string

		switch op {
		case "list":
			method = http.MethodGet
			routePath = basePath
			h = func(c *gin.Context) {
				limit := 20
				if lStr := c.Query("limit"); lStr != "" {
					if val, err := strconv.Atoi(lStr); err == nil && val >= 0 {
						if val > 100 {
							val = 100
						}
						limit = val
					}
				}

				offset := 0
				if oStr := c.Query("offset"); oStr != "" {
					if val, err := strconv.Atoi(oStr); err == nil && val >= 0 {
						offset = val
					}
				}

				filters := make(map[string]string)
				for name := range filterableFields {
					if val := c.Query(name); val != "" {
						filters[name] = val
					}
				}

				items, total, err := handler.List(c.Request.Context(), limit, offset, filters)
				if err != nil {
					WriteProblem(c, http.StatusInternalServerError, "", err.Error())
					return
				}

				if items == nil {
					items = []any{}
				}

				c.JSON(http.StatusOK, gin.H{
					"items":  items,
					"total":  total,
					"limit":  limit,
					"offset": offset,
				})
			}

		case "get":
			method = http.MethodGet
			routePath = itemPath
			h = func(c *gin.Context) {
				id := c.Param(idField)
				res, err := handler.Get(c.Request.Context(), id)
				if err != nil {
					if errors.Is(err, httpserver.ErrNotFound) {
						WriteProblem(c, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id))
						return
					}
					WriteProblem(c, http.StatusInternalServerError, "", err.Error())
					return
				}
				if res == nil {
					WriteProblem(c, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id))
					return
				}

				c.JSON(http.StatusOK, res)
			}

		case "create":
			method = http.MethodPost
			routePath = basePath
			h = func(c *gin.Context) {
				var body map[string]any
				if err := c.ShouldBindJSON(&body); err != nil {
					WriteValidationProblem(c, []string{"_body"})
					return
				}

				if fields, ok := dto.Validate(spec, "create", body); !ok {
					WriteValidationProblem(c, fields)
					return
				}

				res, err := handler.Create(c.Request.Context(), body)
				if err != nil {
					WriteProblem(c, http.StatusInternalServerError, "", err.Error())
					return
				}

				c.JSON(http.StatusCreated, res)
			}

		case "update":
			method = http.MethodPatch
			routePath = itemPath
			h = func(c *gin.Context) {
				id := c.Param(idField)

				var body map[string]any
				if err := c.ShouldBindJSON(&body); err != nil {
					WriteValidationProblem(c, []string{"_body"})
					return
				}

				if fields, ok := dto.Validate(spec, "update", body); !ok {
					WriteValidationProblem(c, fields)
					return
				}

				res, err := handler.Update(c.Request.Context(), id, body)
				if err != nil {
					if errors.Is(err, httpserver.ErrNotFound) {
						WriteProblem(c, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id))
						return
					}
					WriteProblem(c, http.StatusInternalServerError, "", err.Error())
					return
				}

				c.JSON(http.StatusOK, res)
			}

		case "delete":
			method = http.MethodDelete
			routePath = itemPath
			h = func(c *gin.Context) {
				id := c.Param(idField)
				if err := handler.Delete(c.Request.Context(), id); err != nil {
					if errors.Is(err, httpserver.ErrNotFound) {
						WriteProblem(c, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id))
						return
					}
					WriteProblem(c, http.StatusInternalServerError, "", err.Error())
					return
				}

				c.Status(http.StatusNoContent)
			}
		}

		if h != nil {
			var handlers []gin.HandlerFunc
			if spec.Security != nil && spec.Security.Ops != nil {
				if requiredScopes, ok := spec.Security.Ops[op]; ok && requiredScopes != nil {
					handlers = append(handlers, EnforceScopeAuth(requiredScopes, cfg.authExtractor))
				}
			}
			handlers = append(handlers, h)
			router.Handle(method, routePath, handlers...)
		}
	}

	for _, act := range spec.Actions {
		action := act
		actionRoute := itemPath + "/actions/" + action.Name

		var h gin.HandlerFunc = func(c *gin.Context) {
			id := c.Param(idField)

			var body map[string]any
			if len(action.Input) > 0 {
				if err := c.ShouldBindJSON(&body); err != nil {
					if errors.Is(err, io.EOF) {
						body = make(map[string]any)
					} else {
						WriteValidationProblem(c, []string{"_body"})
						return
					}
				}

				if fields, ok := dto.Validate(spec, "action:"+action.Name, body); !ok {
					WriteValidationProblem(c, fields)
					return
				}
			} else {
				_ = c.ShouldBindJSON(&body)
				if body == nil {
					body = make(map[string]any)
				}
			}

			res, err := handler.Action(c.Request.Context(), id, action.Name, body)
			if err != nil {
				if errors.Is(err, httpserver.ErrNotFound) {
					WriteProblem(c, http.StatusNotFound, "Not Found", fmt.Sprintf("entity with id %s not found", id))
					return
				}
				WriteProblem(c, http.StatusInternalServerError, "", err.Error())
				return
			}

			c.JSON(http.StatusOK, res)
		}

		var handlers []gin.HandlerFunc
		if spec.Security != nil && spec.Security.Actions != nil {
			if requiredScopes, ok := spec.Security.Actions[action.Name]; ok && requiredScopes != nil {
				handlers = append(handlers, EnforceScopeAuth(requiredScopes, cfg.authExtractor))
			}
		}
		handlers = append(handlers, h)
		router.Handle(http.MethodPost, actionRoute, handlers...)
	}
}

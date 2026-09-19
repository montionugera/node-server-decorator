package ginadapter

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

// WriteProblem writes an RFC 9457 Problem Details response using c.Data
// to preserve the application/problem+json Content-Type without Gin's override.
func WriteProblem(c *gin.Context, status int, title, detail string) {
	if title == "" {
		title = http.StatusText(status)
	}
	prob := httpserver.Problem{
		Type:     "about:blank",
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: c.Request.URL.Path,
	}
	data, _ := json.Marshal(prob)
	c.Data(status, httpserver.ProblemContentType, data)
}

// WriteValidationProblem writes an RFC 9457 Validation Problem Details response with status 400.
func WriteValidationProblem(c *gin.Context, fields []string) {
	if fields == nil {
		fields = []string{}
	}
	prob := httpserver.ValidationProblem{
		Problem: httpserver.Problem{
			Type:     httpserver.ValidationProblemType,
			Title:    "Validation Failed",
			Status:   http.StatusBadRequest,
			Instance: c.Request.URL.Path,
		},
		Fields: fields,
	}
	data, _ := json.Marshal(prob)
	c.Data(http.StatusBadRequest, httpserver.ProblemContentType, data)
}

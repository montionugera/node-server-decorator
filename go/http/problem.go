package httpserver

import (
	"encoding/json"
	"net/http"
)

const (
	// ProblemContentType is the standard Content-Type for RFC 9457 problem details.
	ProblemContentType = "application/problem+json"

	// ValidationProblemType is the type URI for validation error problem details.
	ValidationProblemType = "https://server-decorator.dev/errors/validation"
)

// Problem represents an RFC 9457 Problem Details object.
type Problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Instance string `json:"instance,omitempty"`
}

// ValidationProblem represents an RFC 9457 Problem Details object for validation errors.
type ValidationProblem struct {
	Problem
	Fields []string `json:"fields"`
}

// WriteProblem writes an RFC 9457 Problem Details response.
func WriteProblem(w http.ResponseWriter, status int, title, detail, instance string) {
	if title == "" {
		title = http.StatusText(status)
	}
	prob := Problem{
		Type:     "about:blank",
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: instance,
	}
	w.Header().Set("Content-Type", ProblemContentType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(prob)
}

// WriteValidationProblem writes an RFC 9457 Validation Problem Details response with status 400.
func WriteValidationProblem(w http.ResponseWriter, fields []string, instance string) {
	if fields == nil {
		fields = []string{}
	}
	prob := ValidationProblem{
		Problem: Problem{
			Type:     ValidationProblemType,
			Title:    "Validation Failed",
			Status:   http.StatusBadRequest,
			Instance: instance,
		},
		Fields: fields,
	}
	w.Header().Set("Content-Type", ProblemContentType)
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(prob)
}

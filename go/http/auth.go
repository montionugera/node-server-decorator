package httpserver

import "net/http"

// ScopeExtractor extracts authentication status and scopes from an HTTP request.
type ScopeExtractor func(r *http.Request) (authenticated bool, scopes []string, err error)

// CheckScopes returns true if held contains all required scopes; otherwise false and the first missing scope name.
func CheckScopes(required []string, held []string) (bool, string) {
	if len(required) == 0 {
		return true, ""
	}
	heldMap := make(map[string]struct{}, len(held))
	for _, s := range held {
		heldMap[s] = struct{}{}
	}
	for _, req := range required {
		if _, ok := heldMap[req]; !ok {
			return false, req
		}
	}
	return true, ""
}

// EnforceScopeAuth wraps an http.HandlerFunc to enforce authentication and required scopes.
func EnforceScopeAuth(requiredScopes []string, extractor ScopeExtractor, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if extractor == nil {
			if next != nil {
				next(w, r)
			}
			return
		}

		authenticated, scopes, err := extractor(r)
		if err != nil || !authenticated {
			WriteProblem(w, http.StatusUnauthorized, "Unauthorized", "authentication required", r.URL.Path)
			return
		}

		if len(requiredScopes) > 0 {
			ok, missing := CheckScopes(requiredScopes, scopes)
			if !ok {
				WriteProblem(w, http.StatusForbidden, "Forbidden", "missing required scope: "+missing, r.URL.Path)
				return
			}
		}

		if next != nil {
			next(w, r)
		}
	}
}

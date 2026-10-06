package ginadapter

import (
	"net/http"

	"github.com/gin-gonic/gin"
	httpserver "github.com/montionugera/node-server-decorator/v2/go/http"
)

// ScopeExtractor extracts authentication status and scopes from a Gin context.
type ScopeExtractor func(c *gin.Context) (authenticated bool, scopes []string, err error)

// EnforceScopeAuth returns a Gin middleware enforcing authentication and required scopes.
// It calls c.Abort() upon authentication or authorization failures to stop the middleware chain.
func EnforceScopeAuth(requiredScopes []string, extractor ScopeExtractor) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Fail closed: declared security with no extractor never exposes the route.
		if extractor == nil {
			WriteProblem(c, http.StatusUnauthorized, "Unauthorized", "authentication required")
			c.Abort()
			return
		}

		authenticated, scopes, err := extractor(c)
		if err != nil || !authenticated {
			WriteProblem(c, http.StatusUnauthorized, "Unauthorized", "authentication required")
			c.Abort()
			return
		}

		if len(requiredScopes) > 0 {
			ok, missing := httpserver.CheckScopes(requiredScopes, scopes)
			if !ok {
				WriteProblem(c, http.StatusForbidden, "Forbidden", "missing required scope: "+missing)
				c.Abort()
				return
			}
		}

		c.Next()
	}
}

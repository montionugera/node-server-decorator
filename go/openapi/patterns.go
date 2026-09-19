package openapi

// Regex patterns copied from contracts/rules/entity-spec-validation.md.
// Kept byte-identical to gen-openapi's patterns.ts, patterns.py, and gen_openapi.nim.
const (
	EmailPattern = `^[a-zA-Z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`
	UuidPattern  = `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
	UriPattern   = `^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$`
)

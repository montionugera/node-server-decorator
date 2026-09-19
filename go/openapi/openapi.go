package openapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"unicode"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

// BaseType maps EntitySpec field types to JSON schema types.
var baseTypes = map[string]string{
	"str":      "string",
	"ref":      "string",
	"int":      "integer",
	"float":    "number",
	"bool":     "boolean",
	"datetime": "string",
	"enum":     "string",
	"list":     "array",
	"obj":      "object",
}

// Capitalize capitalizes the first ASCII character of a string.
func Capitalize(s string) string {
	if len(s) == 0 {
		return ""
	}
	r := []rune(s)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

func formatPattern(format string) (string, error) {
	switch format {
	case "email":
		return EmailPattern, nil
	case "uuid":
		return UuidPattern, nil
	case "uri":
		return UriPattern, nil
	default:
		return "", fmt.Errorf("unknown format: %s", format)
	}
}

// JSONSchema represents a dynamic JSON schema map.
type JSONSchema = map[string]any

// KeepFunc decides whether a field should be included in a schema.
type KeepFunc func(f entity.Field) bool

func keepAll(f entity.Field) bool { return true }

// JSONSchemaForField converts an entity.Field to its OpenAPI/JSON Schema representation.
func JSONSchemaForField(f entity.Field, keep KeepFunc) (JSONSchema, error) {
	if keep == nil {
		keep = keepAll
	}
	base, ok := baseTypes[f.Type]
	if !ok {
		return nil, fmt.Errorf("unknown field type: %s", f.Type)
	}

	s := make(JSONSchema)
	if f.Nullable {
		s["type"] = []any{base, "null"}
	} else {
		s["type"] = base
	}

	if f.Type == "datetime" {
		s["format"] = "date-time"
	}

	if f.Type == "str" || f.Type == "ref" {
		if f.Format != "" {
			s["format"] = f.Format
			pat, err := formatPattern(f.Format)
			if err != nil {
				return nil, err
			}
			s["pattern"] = pat
		}
		if f.Pattern != "" {
			s["pattern"] = f.Pattern
		}
		if f.Min != nil {
			s["minLength"] = *f.Min
		}
		if f.Max != nil {
			s["maxLength"] = *f.Max
		}
	}

	if f.Type == "int" || f.Type == "float" {
		if f.Min != nil {
			s["minimum"] = *f.Min
		}
		if f.Max != nil {
			s["maximum"] = *f.Max
		}
	}

	if f.Type == "enum" && len(f.Enum) > 0 {
		enumCopy := make([]any, len(f.Enum))
		for i, v := range f.Enum {
			enumCopy[i] = v
		}
		s["enum"] = enumCopy
	}

	if f.Type == "list" {
		if f.Item != nil {
			itemSchema, err := JSONSchemaForField(*f.Item, keep)
			if err != nil {
				return nil, err
			}
			s["items"] = itemSchema
		} else {
			s["items"] = make(JSONSchema)
		}
		if f.Min != nil {
			s["minItems"] = *f.Min
		}
		if f.Max != nil {
			s["maxItems"] = *f.Max
		}
	}

	if f.Type == "obj" {
		var kept []entity.Field
		for _, sub := range f.Fields {
			if keep(sub) {
				kept = append(kept, sub)
			}
		}
		props, err := ObjectProperties(kept, keep)
		if err != nil {
			return nil, err
		}
		s["properties"] = props

		var required []string
		for _, sub := range kept {
			if !sub.Optional {
				required = append(required, sub.Name)
			}
		}
		if len(required) > 0 {
			s["required"] = required
		}
		s["additionalProperties"] = false
	}

	if f.Description != "" {
		s["description"] = f.Description
	}

	return s, nil
}

// ObjectProperties returns the map of property schemas for the given fields.
func ObjectProperties(fields []entity.Field, keep KeepFunc) (map[string]any, error) {
	out := make(map[string]any)
	for _, f := range fields {
		if keep(f) {
			sc, err := JSONSchemaForField(f, keep)
			if err != nil {
				return nil, err
			}
			out[f.Name] = sc
		}
	}
	return out, nil
}

func strictObject(fields []entity.Field, keep KeepFunc) (JSONSchema, error) {
	var kept []entity.Field
	for _, f := range fields {
		if keep(f) {
			kept = append(kept, f)
		}
	}
	props, err := ObjectProperties(kept, keep)
	if err != nil {
		return nil, err
	}
	s := JSONSchema{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	var required []string
	for _, f := range kept {
		if !f.Optional {
			required = append(required, f.Name)
		}
	}
	if len(required) > 0 {
		s["required"] = required
	}
	return s, nil
}

func listEnvelope(entityName, pagination string) JSONSchema {
	items := JSONSchema{
		"type":  "array",
		"items": JSONSchema{"$ref": fmt.Sprintf("#/components/schemas/%sRead", entityName)},
	}
	limit := JSONSchema{
		"type":    "integer",
		"minimum": 1,
		"maximum": 100,
	}

	if pagination == "cursor" {
		return JSONSchema{
			"type": "object",
			"properties": JSONSchema{
				"items":      items,
				"nextCursor": JSONSchema{"type": []any{"string", "null"}},
			},
			"required":             []string{"items", "nextCursor"},
			"additionalProperties": false,
		}
	}

	return JSONSchema{
		"type": "object",
		"properties": JSONSchema{
			"items":  items,
			"total":  JSONSchema{"type": "integer", "minimum": 0},
			"limit":  limit,
			"offset": JSONSchema{"type": "integer", "minimum": 0},
		},
		"required":             []string{"items", "total", "limit", "offset"},
		"additionalProperties": false,
	}
}

// ProblemSchemas returns the standard Problem and ValidationProblem schemas.
func ProblemSchemas() map[string]any {
	problemProps := JSONSchema{
		"type":     JSONSchema{"type": "string", "format": "uri"},
		"title":    JSONSchema{"type": "string"},
		"status":   JSONSchema{"type": "integer"},
		"detail":   JSONSchema{"type": "string"},
		"instance": JSONSchema{"type": "string", "format": "uri"},
	}

	valProps := make(JSONSchema)
	for k, v := range problemProps {
		valProps[k] = v
	}
	valProps["fields"] = JSONSchema{
		"type":  "array",
		"items": JSONSchema{"type": "string"},
	}

	return map[string]any{
		"Problem": JSONSchema{
			"type":                 "object",
			"properties":           problemProps,
			"required":             []string{"type", "title", "status"},
			"additionalProperties": false,
		},
		"ValidationProblem": JSONSchema{
			"type":                 "object",
			"properties":           valProps,
			"required":             []string{"type", "title", "status", "fields"},
			"additionalProperties": false,
		},
	}
}

func schemeObject(s entity.Scheme) JSONSchema {
	if s.Type == "apiKey" {
		return JSONSchema{
			"type": "apiKey",
			"in":   s.In,
			"name": s.ParamName,
		}
	}
	out := JSONSchema{
		"type":   "http",
		"scheme": s.Scheme,
	}
	if s.BearerFormat != "" {
		out["bearerFormat"] = s.BearerFormat
	}
	return out
}

func openapiComponents(spec entity.Spec) (map[string]any, map[string]any, error) {
	e := spec.Entity
	create, err := strictObject(spec.Fields, func(f entity.Field) bool { return !f.Readonly })
	if err != nil {
		return nil, nil, err
	}

	update := make(JSONSchema)
	for k, v := range create {
		if k != "required" {
			update[k] = v
		}
	}

	read, err := strictObject(spec.Fields, func(f entity.Field) bool { return !f.Writeonly })
	if err != nil {
		return nil, nil, err
	}

	schemas := map[string]any{
		fmt.Sprintf("%sCreate", e):       create,
		fmt.Sprintf("%sUpdate", e):       update,
		fmt.Sprintf("%sRead", e):         read,
		fmt.Sprintf("%sListResponse", e): listEnvelope(e, spec.Pagination),
	}

	for _, a := range spec.Actions {
		actSchema, err := strictObject(a.Input, keepAll)
		if err != nil {
			return nil, nil, err
		}
		schemas[fmt.Sprintf("%s%sInput", e, Capitalize(a.Name))] = actSchema
	}

	secSchemes := make(map[string]any)
	if spec.Security != nil {
		for _, s := range spec.Security.Schemes {
			secSchemes[s.Name] = schemeObject(s)
		}
	}

	return schemas, secSchemes, nil
}

func problemResponse(status, description, component string) (string, JSONSchema) {
	return status, JSONSchema{
		"description": description,
		"content": JSONSchema{
			"application/problem+json": JSONSchema{
				"schema": JSONSchema{
					"$ref": fmt.Sprintf("#/components/schemas/%s", component),
				},
			},
		},
	}
}

func jsonBody(refName string) JSONSchema {
	return JSONSchema{
		"content": JSONSchema{
			"application/json": JSONSchema{
				"schema": JSONSchema{
					"$ref": fmt.Sprintf("#/components/schemas/%s", refName),
				},
			},
		},
	}
}

func requestBody(refName string) JSONSchema {
	body := jsonBody(refName)
	body["required"] = true
	return body
}

func idField(spec entity.Spec) (entity.Field, error) {
	for _, f := range spec.Fields {
		if f.Role == "id" {
			return f, nil
		}
	}
	return entity.Field{}, fmt.Errorf("%s: no field with role \"id\"", spec.Entity)
}

func securityFor(spec entity.Spec, key, kind string) []any {
	if spec.Security == nil {
		return nil
	}
	var scopesMap map[string][]string
	if kind == "ops" {
		scopesMap = spec.Security.Ops
	} else {
		scopesMap = spec.Security.Actions
	}
	scopes, ok := scopesMap[key]
	if !ok || len(spec.Security.Schemes) == 0 {
		return nil
	}
	schemeName := spec.Security.Schemes[0].Name
	return []any{
		map[string]any{
			schemeName: scopes,
		},
	}
}

func filterParams(spec entity.Spec) ([]JSONSchema, error) {
	var out []JSONSchema
	for _, f := range spec.Fields {
		if !f.Filterable {
			continue
		}
		rest := f
		rest.Optional = false
		rest.Nullable = false
		sc, err := JSONSchemaForField(rest, keepAll)
		if err != nil {
			return nil, err
		}
		out = append(out, JSONSchema{
			"name":     f.Name,
			"in":       "query",
			"required": false,
			"schema":   sc,
		})
	}
	return out, nil
}

func paginationParams(spec entity.Spec) []JSONSchema {
	limit := JSONSchema{
		"name":     "limit",
		"in":       "query",
		"required": false,
		"schema": JSONSchema{
			"type":    "integer",
			"minimum": 1,
			"maximum": 100,
			"default": 20,
		},
	}
	if spec.Pagination == "cursor" {
		return []JSONSchema{
			limit,
			{
				"name":     "cursor",
				"in":       "query",
				"required": false,
				"schema":   JSONSchema{"type": "string"},
			},
		}
	}
	return []JSONSchema{
		limit,
		{
			"name":     "offset",
			"in":       "query",
			"required": false,
			"schema": JSONSchema{
				"type":    "integer",
				"minimum": 0,
				"default": 0,
			},
		},
	}
}

func hasOp(ops []string, target string) bool {
	for _, op := range ops {
		if op == target {
			return true
		}
	}
	return false
}

func openapiPaths(spec entity.Spec) (map[string]any, error) {
	e := spec.Entity
	base := fmt.Sprintf("/%s", spec.Path)
	id, err := idField(spec)
	if err != nil {
		return nil, err
	}

	idNoRole := id
	idNoRole.Role = ""
	idSchema, err := JSONSchemaForField(idNoRole, keepAll)
	if err != nil {
		return nil, err
	}
	idParam := JSONSchema{
		"name":     id.Name,
		"in":       "path",
		"required": true,
		"schema":   idSchema,
	}

	out := make(map[string]any)
	collection := make(map[string]any)
	item := make(map[string]any)

	ok200 := func(refName string) (string, JSONSchema) {
		r := jsonBody(refName)
		r["description"] = "OK"
		return "200", r
	}

	if hasOp(spec.Ops, "list") {
		fp, err := filterParams(spec)
		if err != nil {
			return nil, err
		}
		params := append(paginationParams(spec), fp...)
		sort.Slice(params, func(i, j int) bool {
			return fmt.Sprintf("%v", params[i]["name"]) < fmt.Sprintf("%v", params[j]["name"])
		})

		responses := make(map[string]any)
		code, resp := ok200(fmt.Sprintf("%sListResponse", e))
		responses[code] = resp
		if len(fp) > 0 {
			c, r := problemResponse("400", "Bad Request", "ValidationProblem")
			responses[c] = r
		}

		op := JSONSchema{
			"operationId": fmt.Sprintf("list%s", e),
			"parameters":  params,
			"responses":   responses,
		}
		if len(spec.Tags) > 0 {
			op["tags"] = spec.Tags
		}
		if sec := securityFor(spec, "list", "ops"); sec != nil {
			op["security"] = sec
		}
		collection["get"] = op
	}

	if hasOp(spec.Ops, "create") {
		created := jsonBody(fmt.Sprintf("%sRead", e))
		created["description"] = "Created"
		responses := map[string]any{
			"201": created,
		}
		c400, r400 := problemResponse("400", "Bad Request", "ValidationProblem")
		responses[c400] = r400

		op := JSONSchema{
			"operationId": fmt.Sprintf("create%s", e),
			"requestBody": requestBody(fmt.Sprintf("%sCreate", e)),
			"responses":   responses,
		}
		if len(spec.Tags) > 0 {
			op["tags"] = spec.Tags
		}
		if sec := securityFor(spec, "create", "ops"); sec != nil {
			op["security"] = sec
		}
		collection["post"] = op
	}

	if hasOp(spec.Ops, "get") {
		responses := make(map[string]any)
		code, resp := ok200(fmt.Sprintf("%sRead", e))
		responses[code] = resp
		c404, r404 := problemResponse("404", "Not Found", "Problem")
		responses[c404] = r404

		op := JSONSchema{
			"operationId": fmt.Sprintf("get%s", e),
			"parameters":  []any{idParam},
			"responses":   responses,
		}
		if len(spec.Tags) > 0 {
			op["tags"] = spec.Tags
		}
		if sec := securityFor(spec, "get", "ops"); sec != nil {
			op["security"] = sec
		}
		item["get"] = op
	}

	if hasOp(spec.Ops, "update") {
		responses := make(map[string]any)
		code, resp := ok200(fmt.Sprintf("%sRead", e))
		responses[code] = resp
		c400, r400 := problemResponse("400", "Bad Request", "ValidationProblem")
		responses[c400] = r400
		c404, r404 := problemResponse("404", "Not Found", "Problem")
		responses[c404] = r404

		op := JSONSchema{
			"operationId": fmt.Sprintf("update%s", e),
			"parameters":  []any{idParam},
			"requestBody": requestBody(fmt.Sprintf("%sUpdate", e)),
			"responses":   responses,
		}
		if len(spec.Tags) > 0 {
			op["tags"] = spec.Tags
		}
		if sec := securityFor(spec, "update", "ops"); sec != nil {
			op["security"] = sec
		}
		item["patch"] = op
	}

	if hasOp(spec.Ops, "delete") {
		responses := map[string]any{
			"204": JSONSchema{"description": "No Content"},
		}
		c404, r404 := problemResponse("404", "Not Found", "Problem")
		responses[c404] = r404

		op := JSONSchema{
			"operationId": fmt.Sprintf("delete%s", e),
			"parameters":  []any{idParam},
			"responses":   responses,
		}
		if len(spec.Tags) > 0 {
			op["tags"] = spec.Tags
		}
		if sec := securityFor(spec, "delete", "ops"); sec != nil {
			op["security"] = sec
		}
		item["delete"] = op
	}

	if len(collection) > 0 {
		out[base] = collection
	}
	if len(item) > 0 {
		out[fmt.Sprintf("%s/{%s}", base, id.Name)] = item
	}

	for _, a := range spec.Actions {
		responses := make(map[string]any)
		code, resp := ok200(fmt.Sprintf("%sRead", e))
		responses[code] = resp
		c400, r400 := problemResponse("400", "Bad Request", "ValidationProblem")
		responses[c400] = r400
		c404, r404 := problemResponse("404", "Not Found", "Problem")
		responses[c404] = r404
		if a.From != "" {
			c409, r409 := problemResponse("409", "Conflict", "Problem")
			responses[c409] = r409
		}

		postOp := JSONSchema{
			"operationId": fmt.Sprintf("%s%s", a.Name, e),
			"parameters":  []any{idParam},
			"requestBody": requestBody(fmt.Sprintf("%s%sInput", e, Capitalize(a.Name))),
			"responses":   responses,
		}
		if a.Description != "" {
			postOp["description"] = a.Description
		}
		if len(spec.Tags) > 0 {
			postOp["tags"] = spec.Tags
		}
		if sec := securityFor(spec, a.Name, "actions"); sec != nil {
			postOp["security"] = sec
		}

		actionPath := fmt.Sprintf("%s/{%s}/actions/%s", base, id.Name, a.Name)
		out[actionPath] = map[string]any{
			"post": postOp,
		}
	}

	return out, nil
}

// Generate generates the OpenAPI 3.1 canonical document bytes for the given EntitySpecs and version.
func Generate(specs []entity.Spec, version string) ([]byte, error) {
	schemas := ProblemSchemas()
	securitySchemes := make(map[string]any)
	paths := make(map[string]any)
	tagSet := make(map[string]struct{})

	for _, spec := range specs {
		s, sec, err := openapiComponents(spec)
		if err != nil {
			return nil, err
		}
		for k, v := range s {
			schemas[k] = v
		}
		for k, v := range sec {
			securitySchemes[k] = v
		}
		p, err := openapiPaths(spec)
		if err != nil {
			return nil, err
		}
		for k, v := range p {
			paths[k] = v
		}
		for _, t := range spec.Tags {
			tagSet[t] = struct{}{}
		}
	}

	components := map[string]any{
		"schemas": schemas,
	}
	if len(securitySchemes) > 0 {
		components["securitySchemes"] = securitySchemes
	}

	doc := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "server-decorator API",
			"version": version,
		},
		"paths":      paths,
		"components": components,
	}

	if len(tagSet) > 0 {
		var tagList []string
		for t := range tagSet {
			tagList = append(tagList, t)
		}
		sort.Strings(tagList)
		var tags []map[string]string
		for _, t := range tagList {
			tags = append(tags, map[string]string{"name": t})
		}
		doc["tags"] = tags
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	out := bytes.TrimRight(buf.Bytes(), "\n")
	return out, nil
}

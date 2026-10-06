package dto

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/montionugera/node-server-decorator/v2/go/entity"
)

// Shared format regexes matching contracts/rules/entity-spec-validation.md.
const (
	EmailPattern = `^[a-zA-Z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`
	UuidPattern  = `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
	UriPattern   = `^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$`
	// DateTimePattern is the RFC 3339 shape every lane pre-checks a datetime string against
	// (time.Parse alone also takes a comma as the fractional separator).
	DateTimePattern = `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`
)

var (
	dateTimeRe = regexp.MustCompile(DateTimePattern)
	emailRe    = regexp.MustCompile(EmailPattern)
	uuidRe     = regexp.MustCompile(UuidPattern)
	uriRe      = regexp.MustCompile(UriPattern)
)

type includePredicate func(entity.Field) bool

func notReadonly(f entity.Field) bool {
	return !f.Readonly
}

func notWriteonly(f entity.Field) bool {
	return !f.Writeonly
}

func includeAll(f entity.Field) bool {
	return true
}

// Validate validates a payload against the given EntitySpec and DTO type.
// DTO types: "create", "update", "read", "action:<actionName>".
// payload can be any value, but is typically a map[string]any decoded from JSON.
// Returns a deduplicated, lexicographically sorted list of error field paths, and ok=true if valid.
func Validate(spec entity.Spec, dtoType string, payload any) ([]string, bool) {
	var targetFields []entity.Field
	var include includePredicate

	switch {
	case dtoType == "create":
		include = notReadonly
		targetFields = filterFields(spec.Fields, include)
	case dtoType == "update":
		include = notReadonly
		filtered := filterFields(spec.Fields, include)
		targetFields = make([]entity.Field, len(filtered))
		for i, f := range filtered {
			f.Optional = true
			targetFields[i] = f
		}
	case dtoType == "read":
		include = notWriteonly
		targetFields = filterFields(spec.Fields, include)
	case strings.HasPrefix(dtoType, "action:"):
		actionName := strings.TrimPrefix(dtoType, "action:")
		var found *entity.Action
		for _, a := range spec.Actions {
			if a.Name == actionName {
				found = &a
				break
			}
		}
		if found == nil {
			return []string{"_action"}, false
		}
		include = includeAll
		targetFields = found.Input
	default:
		return []string{"_dto"}, false
	}

	errMap := make(map[string]struct{})
	validateObject(targetFields, payload, "", include, errMap)

	if len(errMap) == 0 {
		return []string{}, true
	}

	errFields := make([]string, 0, len(errMap))
	for f := range errMap {
		errFields = append(errFields, f)
	}
	sort.Strings(errFields)
	return errFields, false
}

func filterFields(fields []entity.Field, predicate includePredicate) []entity.Field {
	var out []entity.Field
	for _, f := range fields {
		if predicate(f) {
			out = append(out, f)
		}
	}
	return out
}

func joinPath(parentPath, fieldName string) string {
	if parentPath == "" {
		return fieldName
	}
	return parentPath + "." + fieldName
}

func validateObject(fields []entity.Field, payload any, currentPath string, include includePredicate, errMap map[string]struct{}) {
	objMap, isMap := payload.(map[string]any)
	if !isMap {
		if currentPath != "" {
			errMap[currentPath] = struct{}{}
		} else {
			errMap["_root"] = struct{}{}
		}
		return
	}

	fieldByName := make(map[string]entity.Field, len(fields))
	for _, f := range fields {
		fieldByName[f.Name] = f
	}

	// 1. Check for unrecognized keys (strict object)
	for k := range objMap {
		if _, exists := fieldByName[k]; !exists {
			errMap[joinPath(currentPath, k)] = struct{}{}
		}
	}

	// 2. Validate declared fields
	for _, f := range fields {
		fPath := joinPath(currentPath, f.Name)
		val, exists := objMap[f.Name]

		if !exists {
			if !f.Optional {
				errMap[fPath] = struct{}{}
			}
			continue
		}

		if val == nil {
			if !f.Nullable {
				errMap[fPath] = struct{}{}
			}
			continue
		}

		validateFieldValue(f, val, fPath, include, errMap)
	}
}

func validateFieldValue(f entity.Field, val any, path string, include includePredicate, errMap map[string]struct{}) {
	switch f.Type {
	case "str", "ref":
		validateString(f, val, path, errMap)
	case "int":
		validateInt(f, val, path, errMap)
	case "float":
		validateFloat(f, val, path, errMap)
	case "bool":
		validateBool(val, path, errMap)
	case "datetime":
		validateDateTime(val, path, errMap)
	case "enum":
		validateEnum(f, val, path, errMap)
	case "list":
		validateList(f, val, path, include, errMap)
	case "obj":
		validateObjField(f, val, path, include, errMap)
	default:
		errMap[path] = struct{}{}
	}
}

func validateString(f entity.Field, val any, path string, errMap map[string]struct{}) {
	s, ok := val.(string)
	if !ok {
		errMap[path] = struct{}{}
		return
	}

	if f.Min != nil && utf8.RuneCountInString(s) < *f.Min {
		errMap[path] = struct{}{}
		return
	}
	if f.Max != nil && utf8.RuneCountInString(s) > *f.Max {
		errMap[path] = struct{}{}
		return
	}

	if f.Format == "email" {
		if !emailRe.MatchString(s) {
			errMap[path] = struct{}{}
			return
		}
	} else if f.Format == "uuid" {
		if !uuidRe.MatchString(s) {
			errMap[path] = struct{}{}
			return
		}
	} else if f.Format == "uri" {
		if !uriRe.MatchString(s) {
			errMap[path] = struct{}{}
			return
		}
	} else if f.Pattern != "" {
		re, err := regexp.Compile(f.Pattern)
		if err != nil || !re.MatchString(s) {
			errMap[path] = struct{}{}
			return
		}
	}
}

func validateInt(f entity.Field, val any, path string, errMap map[string]struct{}) {
	switch v := val.(type) {
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			// Might be a float like 5.0
			fl, err2 := v.Float64()
			if err2 != nil || fl != float64(int64(fl)) {
				errMap[path] = struct{}{}
				return
			}
			i = int64(fl)
		}
		checkIntBounds(f, int(i), path, errMap)
	case float64:
		if v != float64(int64(v)) {
			errMap[path] = struct{}{}
			return
		}
		checkIntBounds(f, int(v), path, errMap)
	case int:
		checkIntBounds(f, v, path, errMap)
	case int64:
		checkIntBounds(f, int(v), path, errMap)
	default:
		// String or other types rejected
		errMap[path] = struct{}{}
	}
}

func checkIntBounds(f entity.Field, i int, path string, errMap map[string]struct{}) {
	if f.Min != nil && i < *f.Min {
		errMap[path] = struct{}{}
	}
	if f.Max != nil && i > *f.Max {
		errMap[path] = struct{}{}
	}
}

func validateFloat(f entity.Field, val any, path string, errMap map[string]struct{}) {
	var fl float64
	switch v := val.(type) {
	case json.Number:
		parsed, err := v.Float64()
		if err != nil {
			errMap[path] = struct{}{}
			return
		}
		fl = parsed
	case float64:
		fl = v
	case int:
		fl = float64(v)
	case int64:
		fl = float64(v)
	default:
		errMap[path] = struct{}{}
		return
	}

	if f.Min != nil && fl < float64(*f.Min) {
		errMap[path] = struct{}{}
	}
	if f.Max != nil && fl > float64(*f.Max) {
		errMap[path] = struct{}{}
	}
}

func validateBool(val any, path string, errMap map[string]struct{}) {
	if _, ok := val.(bool); !ok {
		errMap[path] = struct{}{}
	}
}

func validateDateTime(val any, path string, errMap map[string]struct{}) {
	s, ok := val.(string)
	if !ok {
		errMap[path] = struct{}{}
		return
	}

	// Must be ISO-8601 with explicit offset (RFC3339 or RFC3339Nano)
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, s)
		if err != nil {
			errMap[path] = struct{}{}
			return
		}
	}

	if !hasExplicitUTCOffset(s) || !dateTimeRe.MatchString(s) {
		errMap[path] = struct{}{}
		return
	}
	_ = t
}

func hasExplicitUTCOffset(s string) bool {
	if strings.HasSuffix(s, "Z") || strings.HasSuffix(s, "z") {
		return true
	}
	if len(s) >= 6 {
		tail := s[len(s)-6:]
		if (tail[0] == '+' || tail[0] == '-') && tail[3] == ':' {
			return true
		}
	}
	return false
}

func validateEnum(f entity.Field, val any, path string, errMap map[string]struct{}) {
	s, ok := val.(string)
	if !ok {
		errMap[path] = struct{}{}
		return
	}
	for _, allowed := range f.Enum {
		if s == allowed {
			return
		}
	}
	errMap[path] = struct{}{}
}

func validateList(f entity.Field, val any, path string, include includePredicate, errMap map[string]struct{}) {
	list, ok := val.([]any)
	if !ok {
		errMap[path] = struct{}{}
		return
	}

	if f.Item != nil {
		itemField := *f.Item
		for i, item := range list {
			itemPath := fmt.Sprintf("%s.%d", path, i)
			// Same null rule as an object member: only a nullable item may be null.
			if item == nil {
				if !itemField.Nullable {
					errMap[itemPath] = struct{}{}
				}
				continue
			}
			validateFieldValue(itemField, item, itemPath, include, errMap)
		}
	}
}

func validateObjField(f entity.Field, val any, path string, include includePredicate, errMap map[string]struct{}) {
	nestedFields := filterFields(f.Fields, include)
	validateObject(nestedFields, val, path, include, errMap)
}

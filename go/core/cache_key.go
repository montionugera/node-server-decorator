package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// MaxKeyBytes is the maximum allowed byte length for a raw cache key before it gets hashed.
// Spec: contracts/rules/cache-key.md (v1.0.0).
const MaxKeyBytes = 250

// BuildCacheKey implements the deterministic cache-key algorithm defined in
// contracts/rules/cache-key.md (v1.0.0).
//
// Arguments are formatted using stable JSON serialization (sorted map keys recursively,
// compact separators ',' and ':' without extra spaces, 'null' for nil). If a non-standard
// type or serialization failure occurs, it falls back to String(v) / fmt.Sprint(v)
// matching Python's default=str.
//
// If kwargs are provided, keys are sorted alphabetically and appended as key=val.
// Raw key = qualname + "(" + argRepr + ")"
// If len(raw) <= 250 bytes: returns raw
// Otherwise: returns qualname + "(sha256:" + sha256Hex(raw) + ")"
func BuildCacheKey(qualname string, args []any, kwargs map[string]any) string {
	argPieces := make([]string, 0, len(args)+len(kwargs))
	for _, a := range args {
		argPieces = append(argPieces, stableStringify(a))
	}
	if len(kwargs) > 0 {
		keys := make([]string, 0, len(kwargs))
		for k := range kwargs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			argPieces = append(argPieces, fmt.Sprintf("%s=%s", k, stableStringify(kwargs[k])))
		}
	}
	argRepr := strings.Join(argPieces, ",")
	raw := fmt.Sprintf("%s(%s)", qualname, argRepr)
	if len([]byte(raw)) <= MaxKeyBytes {
		return raw
	}
	digest := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("%s(sha256:%s)", qualname, hex.EncodeToString(digest[:]))
}

func stableStringify(v any) string {
	if v == nil {
		return "null"
	}

	switch val := v.(type) {
	case string:
		b, _ := json.Marshal(val)
		return string(b)
	case bool:
		if val {
			return "true"
		}
		return "false"
	case int:
		return strconv.FormatInt(int64(val), 10)
	case int8:
		return strconv.FormatInt(int64(val), 10)
	case int16:
		return strconv.FormatInt(int64(val), 10)
	case int32:
		return strconv.FormatInt(int64(val), 10)
	case int64:
		return strconv.FormatInt(val, 10)
	case uint:
		return strconv.FormatUint(uint64(val), 10)
	case uint8:
		return strconv.FormatUint(uint64(val), 10)
	case uint16:
		return strconv.FormatUint(uint64(val), 10)
	case uint32:
		return strconv.FormatUint(uint64(val), 10)
	case uint64:
		return strconv.FormatUint(val, 10)
	case float32:
		b, err := json.Marshal(val)
		if err != nil {
			fallback, _ := json.Marshal(fmt.Sprint(val))
			return string(fallback)
		}
		return string(b)
	case float64:
		b, err := json.Marshal(val)
		if err != nil {
			fallback, _ := json.Marshal(fmt.Sprint(val))
			return string(fallback)
		}
		return string(b)
	case json.Number:
		return val.String()
	case []any:
		parts := make([]string, len(val))
		for i, elem := range val {
			parts[i] = stableStringify(elem)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			kb, _ := json.Marshal(k)
			parts[i] = string(kb) + ":" + stableStringify(val[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return "null"
		}
		return stableStringify(rv.Elem().Interface())
	case reflect.Slice, reflect.Array:
		n := rv.Len()
		parts := make([]string, n)
		for i := 0; i < n; i++ {
			parts[i] = stableStringify(rv.Index(i).Interface())
		}
		return "[" + strings.Join(parts, ",") + "]"
	case reflect.Map:
		keys := rv.MapKeys()
		type keyEntry struct {
			strKey  string
			origKey reflect.Value
		}
		entries := make([]keyEntry, len(keys))
		for i, k := range keys {
			entries[i] = keyEntry{
				strKey:  fmt.Sprint(k.Interface()),
				origKey: k,
			}
		}
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].strKey < entries[j].strKey
		})
		parts := make([]string, len(entries))
		for i, entry := range entries {
			kb, _ := json.Marshal(entry.strKey)
			parts[i] = string(kb) + ":" + stableStringify(rv.MapIndex(entry.origKey).Interface())
		}
		return "{" + strings.Join(parts, ",") + "}"
	case reflect.Struct:
		data, err := json.Marshal(v)
		if err == nil {
			var unmarshaled any
			d := json.NewDecoder(bytes.NewReader(data))
			d.UseNumber()
			if err := d.Decode(&unmarshaled); err == nil {
				return stableStringify(unmarshaled)
			}
		}
		fallback, _ := json.Marshal(fmt.Sprint(v))
		return string(fallback)
	default:
		fallback, _ := json.Marshal(fmt.Sprint(v))
		return string(fallback)
	}
}

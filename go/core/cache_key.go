package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
//
// Panics with an error wrapping ErrNonFiniteCacheArg when an argument contains NaN or
// +/-Infinity (not JSON-serializable per the spec). Use BuildCacheKeyE to get that as a
// returned error instead.
func BuildCacheKey(qualname string, args []any, kwargs map[string]any) string {
	key, err := BuildCacheKeyE(qualname, args, kwargs)
	if err != nil {
		panic(err)
	}
	return key
}

// ErrNonFiniteCacheArg is returned (wrapped) by BuildCacheKeyE and Cache when a cache-key
// argument contains NaN or +/-Infinity.
var ErrNonFiniteCacheArg = errors.New("cache key: non-finite float is not JSON-serializable")

// BuildCacheKeyE is BuildCacheKey returning an error instead of panicking.
func BuildCacheKeyE(qualname string, args []any, kwargs map[string]any) (key string, err error) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(error)
			if !ok || !errors.Is(e, ErrNonFiniteCacheArg) {
				panic(r)
			}
			key, err = "", e
		}
	}()
	return buildCacheKey(qualname, args, kwargs), nil
}

func buildCacheKey(qualname string, args []any, kwargs map[string]any) string {
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

// quoteJSONString encodes s as a JSON string exactly as JavaScript JSON.stringify and
// Python json.dumps(ensure_ascii=False) do: UTF-8 is kept as-is and <, >, & and
// U+2028/U+2029 are NOT escaped (encoding/json escapes all of them).
func quoteJSONString(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func finiteFloat(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		panic(fmt.Errorf("%w (%v)", ErrNonFiniteCacheArg, f))
	}
	return f
}

func stableStringify(v any) string {
	if v == nil {
		return "null"
	}

	switch val := v.(type) {
	case string:
		return quoteJSONString(val)
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
		finiteFloat(float64(val))
		b, _ := json.Marshal(val)
		return string(b)
	case float64:
		b, _ := json.Marshal(finiteFloat(val))
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
			parts[i] = quoteJSONString(k) + ":" + stableStringify(val[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Float32, reflect.Float64:
		// Named float types (type Price float64) miss the type switch above.
		return stableStringify(rv.Float())
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
			parts[i] = quoteJSONString(entry.strKey) + ":" + stableStringify(rv.MapIndex(entry.origKey).Interface())
		}
		return "{" + strings.Join(parts, ",") + "}"
	case reflect.Struct:
		data, err := json.Marshal(v)
		var unsupported *json.UnsupportedValueError
		if errors.As(err, &unsupported) && unsupported.Value.CanFloat() {
			finiteFloat(unsupported.Value.Float())
		}
		if err == nil {
			var unmarshaled any
			d := json.NewDecoder(bytes.NewReader(data))
			d.UseNumber()
			if err := d.Decode(&unmarshaled); err == nil {
				return stableStringify(unmarshaled)
			}
		}
		return quoteJSONString(fmt.Sprint(v))
	default:
		return quoteJSONString(fmt.Sprint(v))
	}
}

use crate::spec::EntitySpec;
use serde_json::Value;
use std::collections::BTreeMap;

/// Recursively sorts all JSON object keys into BTreeMap to guarantee lexicographical sorting.
pub fn canonicalize_value(val: Value) -> Value {
    match val {
        Value::Object(map) => {
            let mut sorted = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k, canonicalize_value(v));
            }
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(canonicalize_value).collect()),
        other => other,
    }
}

/// Serializes an EntitySpec into byte-identical canonical JSON.
///
/// Canonical rules:
/// 1. UTF-8 without unicode escaping for non-ASCII.
/// 2. Object keys sorted lexicographically at every nesting depth.
/// 3. Compact separators `,` and `:` with no whitespace and no trailing newline.
/// 4. Omit-when-default (nulls/empty flags omitted).
pub fn to_canonical_json(spec: &EntitySpec) -> Result<String, serde_json::Error> {
    let val = serde_json::to_value(spec)?;
    let canonical_val = canonicalize_value(val);
    serde_json::to_string(&canonical_val)
}

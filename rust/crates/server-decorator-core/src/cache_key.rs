use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_KEY_BYTES: usize = 250;

pub fn canonical_arg_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")),
        Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_arg_stringify).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            let parts: Vec<String> = sorted
                .into_iter()
                .map(|(k, val)| {
                    let k_str = serde_json::to_string(k).unwrap_or_else(|_| format!("\"{k}\""));
                    format!("{}:{}", k_str, canonical_arg_stringify(val))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

pub fn build_cache_key(qualname: &str, args: &[Value], kwargs: &BTreeMap<String, Value>) -> String {
    let mut pieces = Vec::with_capacity(args.len() + kwargs.len());

    for arg in args {
        pieces.push(canonical_arg_stringify(arg));
    }

    for (k, v) in kwargs {
        pieces.push(format!("{}={}", k, canonical_arg_stringify(v)));
    }

    let arg_repr = pieces.join(",");
    let raw = format!("{qualname}({arg_repr})");

    if raw.len() <= MAX_KEY_BYTES {
        raw
    } else {
        let mut hasher = Sha256::new();
        hasher.update(raw.as_bytes());
        let digest = hex::encode(hasher.finalize());
        format!("{qualname}(sha256:{digest})")
    }
}

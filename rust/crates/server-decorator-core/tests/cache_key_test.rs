use serde::Deserialize;
use serde_json::Value;
use server_decorator_core::cache_key::build_cache_key;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct CacheKeyExample {
    name: String,
    qualname: String,
    args: Vec<Value>,
    kwargs: BTreeMap<String, Value>,
    expected: Option<String>,
    expected_prefix: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CacheKeyFixture {
    examples: Vec<CacheKeyExample>,
}

#[test]
fn test_cache_key_golden_fixtures() {
    let candidates = [
        "../../contracts/fixtures/cache-key.examples.json",
        "contracts/fixtures/cache-key.examples.json",
        "../../../contracts/fixtures/cache-key.examples.json",
    ];

    let mut data = None;
    for path in candidates {
        if Path::new(path).exists() {
            data = Some(fs::read_to_string(path).expect("failed to read fixture"));
            break;
        }
    }

    let data = data.expect("could not find cache-key.examples.json fixture");
    let fixture: CacheKeyFixture =
        serde_json::from_str(&data).expect("failed to parse fixture json");

    for ex in fixture.examples {
        let actual = build_cache_key(&ex.qualname, &ex.args, &ex.kwargs);

        if let Some(ref exp) = ex.expected {
            assert_eq!(
                actual, *exp,
                "Example '{}': expected '{}', got '{}'",
                ex.name, exp, actual
            );
        } else if let Some(ref prefix) = ex.expected_prefix {
            assert!(
                actual.starts_with(prefix),
                "Example '{}': expected prefix '{}', got '{}'",
                ex.name,
                prefix,
                actual
            );
            assert!(actual.ends_with(')'));
        }
    }
}

#[test]
fn test_cache_key_sha256_fallback() {
    let long_str = "a".repeat(300);
    let key = build_cache_key("Service.LongCall", &[Value::String(long_str)], &BTreeMap::new());
    assert!(key.starts_with("Service.LongCall(sha256:"));
    assert!(key.ends_with(')'));
}

#[test]
fn test_cache_key_null_and_false() {
    let mut kwargs = BTreeMap::new();
    kwargs.insert("flag".to_string(), Value::Bool(false));
    let key = build_cache_key("Test.Func", &[Value::Null], &kwargs);
    assert_eq!(key, "Test.Func(null,flag=false)");
}

#[test]
fn test_cache_key_array_arg() {
    let key = build_cache_key(
        "Test.ArrayFunc",
        &[serde_json::json!(["apple", "banana"])],
        &BTreeMap::new(),
    );
    assert_eq!(key, "Test.ArrayFunc([\"apple\",\"banana\"])");
}



use server_decorator_entity::canonical::to_canonical_json;
use server_decorator_entity::testing::user_spec;
use std::fs;
use std::path::Path;

#[test]
fn test_entity_spec_byte_parity() {
    let spec = user_spec();
    let actual = to_canonical_json(&spec).expect("serialization failed");

    let candidates = [
        "../../contracts/fixtures/entity-spec.valid-user.json",
        "contracts/fixtures/entity-spec.valid-user.json",
        "../../../contracts/fixtures/entity-spec.valid-user.json",
    ];

    let mut expected = None;
    for path in candidates {
        if Path::new(path).exists() {
            expected = Some(fs::read_to_string(path).expect("failed to read fixture"));
            break;
        }
    }

    let expected = expected.expect("could not find entity-spec.valid-user.json fixture");
    let expected = expected.trim_end_matches('\n');

    assert_eq!(
        actual, expected,
        "Rust EntitySpec IR must be byte-identical to contract fixture"
    );
}

#[test]
fn test_emit_fixture_binary() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_emit-fixture"))
        .output()
        .expect("failed to run emit-fixture bin");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("\"entity\":\"User\""));
}


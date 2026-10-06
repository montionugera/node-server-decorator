use server_decorator_entity::testing::user_spec;
use server_decorator_openapi::generate;
use std::fs;
use std::path::Path;

#[test]
fn test_openapi_byte_parity() {
    let spec = user_spec();
    let version = include_str!("../../../../contracts/VERSION").trim();
    let actual = generate(&[spec], version).expect("openapi generation failed");

    let candidates = [
        "../../contracts/fixtures/openapi.valid-user.json",
        "contracts/fixtures/openapi.valid-user.json",
        "../../../contracts/fixtures/openapi.valid-user.json",
    ];

    let mut expected = None;
    for path in candidates {
        if Path::new(path).exists() {
            expected = Some(fs::read_to_string(path).expect("failed to read fixture"));
            break;
        }
    }

    let expected = expected.expect("could not find openapi.valid-user.json fixture");
    let expected = expected.trim_end_matches('\n');

    assert_eq!(
        actual, expected,
        "Rust OpenAPI document must be byte-identical to contract fixture"
    );
}

#[test]
fn test_emit_openapi_binary() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_emit-openapi"))
        .output()
        .expect("failed to run emit-openapi bin");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("\"openapi\":\"3.1.0\""));
}

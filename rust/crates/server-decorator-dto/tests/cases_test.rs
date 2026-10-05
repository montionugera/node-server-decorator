use serde::Deserialize;
use serde_json::Value;
use server_decorator_dto::validate;
use server_decorator_entity::testing::user_spec;
use std::fs;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct ContractCase {
    name: String,
    dto: String,
    payload: Value,
    valid: bool,
    #[serde(rename = "errorFields")]
    error_fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FixtureData {
    entity: String,
    cases: Vec<ContractCase>,
}

#[test]
fn test_all_contract_cases() {
    let spec = user_spec();

    let candidates = [
        "../../contracts/fixtures/entity-spec.cases.json",
        "contracts/fixtures/entity-spec.cases.json",
        "../../../contracts/fixtures/entity-spec.cases.json",
    ];

    let mut data = None;
    for path in candidates {
        if Path::new(path).exists() {
            data = Some(fs::read_to_string(path).expect("failed to read fixture"));
            break;
        }
    }

    let data = data.expect("could not find entity-spec.cases.json");
    let fixture: FixtureData = serde_json::from_str(&data).expect("failed to parse fixture json");

    assert_eq!(
        fixture.cases.len(),
        22,
        "Expected exactly 22 contract test cases"
    );

    for c in fixture.cases {
        let (err_fields, is_valid) = validate(&spec, &c.dto, &c.payload);

        assert_eq!(
            is_valid, c.valid,
            "Case '{}': expected valid={}, got valid={}. Errors: {:?}",
            c.name, c.valid, is_valid, err_fields
        );

        let mut expected_errors = c.error_fields.clone();
        expected_errors.sort();

        let mut actual_errors = err_fields.clone();
        actual_errors.sort();

        assert_eq!(
            actual_errors, expected_errors,
            "Case '{}': error fields mismatch",
            c.name
        );
    }
}

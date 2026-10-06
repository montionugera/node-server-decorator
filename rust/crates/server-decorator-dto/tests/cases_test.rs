use serde::Deserialize;
use serde_json::Value;
use server_decorator_dto::validate;
use server_decorator_entity::spec::EntitySpec;
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
    #[serde(default)]
    spec: Option<EntitySpec>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct FixtureData {
    entity: String,
    cases: Vec<ContractCase>,
}

#[test]
fn test_all_contract_cases() {
    let default_spec = user_spec();

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

    assert!(
        !fixture.cases.is_empty(),
        "Expected contract test cases to not be empty"
    );

    for c in fixture.cases {
        let spec = c.spec.as_ref().unwrap_or(&default_spec);
        let (err_fields, is_valid) = validate(spec, &c.dto, &c.payload);

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

use server_decorator_entity::builder::{
    act, enum_field, list_field, obj_field, opt_format, opt_item, opt_pattern, opt_sub,
    opt_values, str_field, EntityBuilder,
};
use server_decorator_entity::spec::{SchemeSpec, SecuritySpec};
use server_decorator_entity::validate::ValidationError;
use std::collections::BTreeMap;

#[test]
fn test_validation_empty_transports() {
    let res = EntityBuilder::new("Test", "tests")
        .transports(Vec::<String>::new())
        .build();
    assert!(matches!(res, Err(ValidationError::EmptyTransports { .. })));
}

#[test]
fn test_validation_empty_ops() {
    let res = EntityBuilder::new("Test", "tests")
        .ops(Vec::<String>::new())
        .build();
    assert!(matches!(res, Err(ValidationError::EmptyOps { .. })));
}

#[test]
fn test_validation_reserved_wire_name() {
    let res = EntityBuilder::new("Test", "tests")
        .fields([str_field("model_dump", vec![])])
        .build();
    assert!(matches!(res, Err(ValidationError::ReservedWireName { .. })));
}

#[test]
fn test_validation_format_and_pattern_mutually_exclusive() {
    let res = EntityBuilder::new("Test", "tests")
        .fields([str_field(
            "code",
            vec![opt_format("email"), opt_pattern(r"^[A-Z]+$")],
        )])
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::FormatAndPatternMutuallyExclusive { .. })
    ));
}

#[test]
fn test_validation_lookaround_in_pattern() {
    let res = EntityBuilder::new("Test", "tests")
        .fields([str_field(
            "pwd",
            vec![opt_pattern(r"^(?=.*[A-Z]).+$")],
        )])
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::LookaroundInPattern { .. })
    ));
}

#[test]
fn test_validation_backreference_in_pattern() {
    let res = EntityBuilder::new("Test", "tests")
        .fields([str_field(
            "dup",
            vec![opt_pattern(r"^([a-z])\1+$")],
        )])
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::BackreferenceInPattern { .. })
    ));
}

#[test]
fn test_validation_empty_enum() {
    let res = EntityBuilder::new("Test", "tests")
        .fields([enum_field("status", vec![opt_values(Vec::<String>::new())])])
        .build();
    assert!(matches!(res, Err(ValidationError::EmptyEnum { .. })));
}

#[test]
fn test_validation_nested_and_item_fields() {
    let nested_field = str_field("model_validate", vec![]);
    let res = EntityBuilder::new("Test", "tests")
        .fields([obj_field("nested", vec![opt_sub([nested_field])])])
        .build();
    assert!(matches!(res, Err(ValidationError::ReservedWireName { .. })));

    let item_field = str_field("json", vec![]);
    let res = EntityBuilder::new("Test", "tests")
        .fields([list_field("items", vec![opt_item(item_field)])])
        .build();
    assert!(matches!(res, Err(ValidationError::ReservedWireName { .. })));

    let action_field = str_field("parse_raw", vec![]);
    let action = act("act").input([action_field]).build();
    let res = EntityBuilder::new("Test", "tests")
        .actions([action])
        .build();
    assert!(matches!(res, Err(ValidationError::ReservedWireName { .. })));
}

#[test]
fn test_validation_security_errors() {
    // Empty schemes
    let empty_sec = SecuritySpec {
        actions: None,
        ops: None,
        schemes: vec![],
    };
    let res = EntityBuilder::new("Test", "tests").secure(empty_sec).build();
    assert!(matches!(
        res,
        Err(ValidationError::EmptySecuritySchemes { .. })
    ));

    // Invalid scheme type
    let invalid_type_sec = SecuritySpec {
        actions: None,
        ops: None,
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: None,
            name: "bad".into(),
            param_name: None,
            scheme: None,
            r#type: "oauth2".into(),
        }],
    };
    let res = EntityBuilder::new("Test", "tests")
        .secure(invalid_type_sec)
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::InvalidSchemeType { .. })
    ));

    // Missing http scheme
    let missing_http_sec = SecuritySpec {
        actions: None,
        ops: None,
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: None,
            name: "bearer".into(),
            param_name: None,
            scheme: None,
            r#type: "http".into(),
        }],
    };
    let res = EntityBuilder::new("Test", "tests")
        .secure(missing_http_sec)
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::MissingHttpScheme { .. })
    ));

    // Missing apiKey fields
    let missing_apikey_sec = SecuritySpec {
        actions: None,
        ops: None,
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: None,
            name: "apikey".into(),
            param_name: None,
            scheme: None,
            r#type: "apiKey".into(),
        }],
    };
    let res = EntityBuilder::new("Test", "tests")
        .secure(missing_apikey_sec)
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::MissingApiKeyFields { .. })
    ));

    // Security op not declared
    let mut bad_ops = BTreeMap::new();
    bad_ops.insert("nonexistent_op".into(), vec!["scheme1".into()]);
    let sec_bad_op = SecuritySpec {
        actions: None,
        ops: Some(bad_ops),
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: Some("header".into()),
            name: "scheme1".into(),
            param_name: Some("X-Key".into()),
            scheme: None,
            r#type: "apiKey".into(),
        }],
    };
    let res = EntityBuilder::new("Test", "tests")
        .secure(sec_bad_op)
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::SecurityOpNotDeclared { .. })
    ));

    // Security action not declared
    let mut bad_actions = BTreeMap::new();
    bad_actions.insert("nonexistent_act".into(), vec!["scheme1".into()]);
    let sec_bad_action = SecuritySpec {
        actions: Some(bad_actions),
        ops: None,
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: Some("header".into()),
            name: "scheme1".into(),
            param_name: Some("X-Key".into()),
            scheme: None,
            r#type: "apiKey".into(),
        }],
    };
    let res = EntityBuilder::new("Test", "tests")
        .secure(sec_bad_action)
        .build();
    assert!(matches!(
        res,
        Err(ValidationError::SecurityActionNotDeclared { .. })
    ));
}

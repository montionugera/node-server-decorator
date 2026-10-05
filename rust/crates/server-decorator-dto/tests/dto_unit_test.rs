use serde_json::json;
use server_decorator_entity::testing::user_spec;
use server_decorator_dto::validate;

#[test]
fn test_dto_unknown_projection() {
    let spec = user_spec();
    let (errs, ok) = validate(&spec, "unknown_type", &json!({}));
    assert!(!ok);
    assert_eq!(errs, vec!["_dto"]);
}

#[test]
fn test_dto_unknown_action() {
    let spec = user_spec();
    let (errs, ok) = validate(&spec, "action:nonexistent", &json!({}));
    assert!(!ok);
    assert_eq!(errs, vec!["_action"]);
}

#[test]
fn test_dto_non_object_root() {
    let spec = user_spec();
    let (errs, ok) = validate(&spec, "create", &json!("not an object"));
    assert!(!ok);
    assert_eq!(errs, vec!["_root"]);
}

#[test]
fn test_dto_read_projection() {
    let spec = user_spec();
    // In read projection, writeonly fields are excluded, readonly fields are included
    let valid_read = json!({
        "id": "u1",
        "email": "user@example.com",
        "name": "Alice",
        "status": "active",
        "loginCount": 5,
        "tags": ["admin"]
    });
    let (errs, ok) = validate(&spec, "read", &valid_read);
    assert!(ok, "unexpected errors: {:?}", errs);

    // If writeonly field is supplied, it is rejected as unknown
    let with_secret = json!({
        "id": "u1",
        "email": "user@example.com",
        "name": "Alice",
        "status": "active",
        "loginCount": 5,
        "tags": ["admin"],
        "secretNote": "secret"
    });
    let (errs, ok) = validate(&spec, "read", &with_secret);
    assert!(!ok);
    assert_eq!(errs, vec!["secretNote"]);
}

#[test]
fn test_dto_field_types_and_constraints() {
    let spec = user_spec();

    // int non-integer (float with fract)
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": [],
        "score": 1.5, // float is allowed here
        "active": "not_a_bool" // should fail
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"active".to_string()));

    // datetime invalid format / missing offset
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": [],
        "birthday": "2023-01-01T00:00:00" // no offset!
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"birthday".to_string()));

    // list with non-array
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": "not_an_array"
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"tags".to_string()));

    // nested obj with non-object
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": [],
        "profile": "not_an_object"
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"profile".to_string()));

    // non-nullable field getting null
    let payload = json!({
        "email": null,
        "name": "Alice",
        "status": "active",
        "tags": []
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"email".to_string()));

    // datetime with explicit timezone offset like +00:00
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": [],
        "birthday": "2023-01-01T12:00:00+02:00"
    });
    let (_, ok) = validate(&spec, "create", &payload);
    assert!(ok);
}

#[test]
fn test_dto_formats_and_bounds() {
    use server_decorator_entity::builder::{
        float_field, int_field, opt_format, opt_max, opt_min, opt_optional, opt_pattern,
        str_field, EntityBuilder,
    };

    let spec = EntityBuilder::new("Item", "items")
        .fields([
            str_field("id", vec![opt_format("uuid")]),
            str_field("url", vec![opt_format("uri"), opt_optional()]),
            str_field("code", vec![opt_pattern(r"^[A-Z]{3}$"), opt_optional()]),
            int_field("count", vec![opt_min(5), opt_max(10), opt_optional()]),
            float_field("score", vec![opt_min(1), opt_max(5), opt_optional()]),
        ])
        .build()
        .unwrap();

    // Valid
    let valid = json!({
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "url": "https://example.com/item",
        "code": "ABC",
        "count": 7,
        "score": 4.5
    });
    let (errs, ok) = validate(&spec, "create", &valid);
    assert!(ok, "unexpected errors: {:?}", errs);

    // Invalid uuid, uri, pattern, count too low, score too high
    let invalid = json!({
        "id": "not-a-uuid",
        "url": "not a uri",
        "code": "abcd",
        "count": 2,
        "score": 10.0
    });
    let (errs, ok) = validate(&spec, "create", &invalid);
    assert!(!ok);
    assert!(errs.contains(&"id".to_string()));
    assert!(errs.contains(&"url".to_string()));
    assert!(errs.contains(&"code".to_string()));
    assert!(errs.contains(&"count".to_string()));
    assert!(errs.contains(&"score".to_string()));

    // Count too high, float as valid integer (7.0), invalid int (string)
    let invalid2 = json!({
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "count": 20,
        "score": "not_a_float"
    });
    let (errs, ok) = validate(&spec, "create", &invalid2);
    assert!(!ok);
    assert!(errs.contains(&"count".to_string()));
    assert!(errs.contains(&"score".to_string()));
}

#[test]
fn test_dto_enum_list_and_unknown_type() {
    let spec = user_spec();

    // 1. Enum non-string
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": 123,
        "tags": []
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"status".to_string()));

    // 2. Enum disallowed string value
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "not_a_valid_status",
        "tags": []
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"status".to_string()));

    // 3. List item error (int in string list)
    let payload = json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": ["valid", 123]
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"tags.1".to_string()));
}

#[test]
fn test_dto_string_bounds_and_unknown_types() {
    let spec = user_spec();

    // String min length (name min is 2)
    let payload = json!({
        "email": "a@b.com",
        "name": "A", // too short!
        "status": "active",
        "tags": []
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"name".to_string()));

    // String max length (name max is 80)
    let payload = json!({
        "email": "a@b.com",
        "name": "A".repeat(81), // too long!
        "status": "active",
        "tags": []
    });
    let (errs, ok) = validate(&spec, "create", &payload);
    assert!(!ok);
    assert!(errs.contains(&"name".to_string()));

    // Unknown field type in create
    let mut bad_spec = user_spec();
    bad_spec.fields.push(server_decorator_entity::builder::str_field("custom", vec![]));
    bad_spec.fields.last_mut().unwrap().r#type = "custom_unknown".into();
    let (errs, ok) = validate(&bad_spec, "create", &json!({
        "email": "a@b.com",
        "name": "Alice",
        "status": "active",
        "tags": [],
        "custom": "123"
    }));
    assert!(!ok);
    assert!(errs.contains(&"custom".to_string()));
}

#[test]
fn test_dto_int_and_float_deep() {
    use server_decorator_entity::builder::{
        float_field, int_field, opt_max, opt_min, str_field, EntityBuilder,
    };

    let spec = EntityBuilder::new("Product", "products")
        .fields([
            str_field("id", vec![]),
            int_field("stock", vec![opt_min(0), opt_max(100)]),
            float_field("price", vec![opt_min(1), opt_max(50)]),
        ])
        .build()
        .unwrap();

    // 1. Valid int as float without fract (e.g. 50.0)
    let valid = json!({
        "id": "p1",
        "stock": 50.0,
        "price": 25.5
    });
    let (_, ok) = validate(&spec, "create", &valid);
    assert!(ok);

    // 2. Invalid int as float with fract (50.5)
    let invalid = json!({
        "id": "p1",
        "stock": 50.5,
        "price": 25.5
    });
    let (errs, ok) = validate(&spec, "create", &invalid);
    assert!(!ok);
    assert!(errs.contains(&"stock".to_string()));

    // 3. Invalid int as string
    let invalid = json!({
        "id": "p1",
        "stock": "not_int",
        "price": 25.5
    });
    let (errs, ok) = validate(&spec, "create", &invalid);
    assert!(!ok);
    assert!(errs.contains(&"stock".to_string()));

    // 4. Int below min (-1) and above max (150)
    let invalid = json!({
        "id": "p1",
        "stock": -1,
        "price": 0.5 // price also below min!
    });
    let (errs, ok) = validate(&spec, "create", &invalid);
    assert!(!ok);
    assert!(errs.contains(&"stock".to_string()));
    assert!(errs.contains(&"price".to_string()));

    let invalid = json!({
        "id": "p1",
        "stock": 150,
        "price": 100.0 // price also above max!
    });
    let (errs, ok) = validate(&spec, "create", &invalid);
    assert!(!ok);
    assert!(errs.contains(&"stock".to_string()));
    assert!(errs.contains(&"price".to_string()));
}





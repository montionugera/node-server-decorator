use server_decorator_entity::builder::{
    act, bool_field, datetime_field, float_field, int_field, list_field, opt_format, opt_id,
    opt_item, opt_max, opt_min, opt_optional, opt_pattern, opt_readonly, str_field, EntityBuilder,
};
use server_decorator_entity::spec::{SchemeSpec, SecuritySpec};
use server_decorator_openapi::generate;
use std::collections::BTreeMap;

#[test]
fn test_openapi_features_coverage() {
    let mut ops_sec = BTreeMap::new();
    ops_sec.insert("list".into(), vec!["apiKeyAuth".into()]);

    let security = SecuritySpec {
        actions: None,
        ops: Some(ops_sec),
        schemes: vec![SchemeSpec {
            bearer_format: None,
            r#in: Some("header".into()),
            name: "apiKeyAuth".into(),
            param_name: Some("X-API-KEY".into()),
            scheme: None,
            r#type: "apiKey".into(),
        }],
    };

    let spec = EntityBuilder::new("Article", "articles")
        .desc("Articles entity")
        .pagination("cursor")
        .secure(security)
        .fields([
            str_field("id", vec![opt_id(), opt_readonly(), opt_format("uuid")]),
            str_field("website", vec![opt_format("uri"), opt_optional()]),
            str_field("customCode", vec![opt_pattern(r"^[A-Z]{3}$"), opt_optional()]),
            int_field("views", vec![opt_min(0), opt_max(1_000_000), opt_optional()]),
            float_field("rating", vec![opt_min(0), opt_max(5), opt_optional()]),
            bool_field("published", vec![opt_optional()]),
            datetime_field("publishedAt", vec![opt_optional()]),
            list_field("tags", vec![
                opt_item(str_field("tag", vec![])),
                opt_min(1),
                opt_max(10),
                opt_optional(),
            ]),
        ])
        .actions([
            act("publish")
                .desc("Publish article")
                .input([str_field("scheduledFor", vec![opt_optional()])])
                .build(),
        ])
        .build()
        .expect("Valid EntitySpec");

    let doc = generate(&[spec], "1.0.0").expect("generate openapi");
    assert!(doc.contains("\"apiKeyAuth\""));
    assert!(doc.contains("\"uuid\""));
    assert!(doc.contains("\"uri\""));
    assert!(doc.contains("\"cursor\""));
}

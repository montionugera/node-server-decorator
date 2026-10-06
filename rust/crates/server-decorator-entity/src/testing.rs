use crate::builder::*;
use crate::spec::*;
use std::collections::BTreeMap;

pub fn user_spec() -> EntitySpec {
    let mut ops_sec = BTreeMap::new();
    ops_sec.insert("create".into(), vec!["user:write".into()]);
    ops_sec.insert("update".into(), vec!["user:write".into()]);
    ops_sec.insert("delete".into(), vec!["user:admin".into()]);

    let mut act_sec = BTreeMap::new();
    act_sec.insert("activate".into(), vec!["user:admin".into()]);

    let security = SecuritySpec {
        actions: Some(act_sec),
        ops: Some(ops_sec),
        schemes: vec![SchemeSpec {
            bearer_format: Some("JWT".into()),
            r#in: None,
            name: "bearerAuth".into(),
            param_name: None,
            scheme: Some("bearer".into()),
            r#type: "http".into(),
        }],
    };

    EntityBuilder::new("User", "users")
        .desc("A registered user account")
        .tags(["identity"])
        .transports(["rest", "rpc", "sse", "ws"])
        .ops(["list", "get", "create", "update", "delete"])
        .pagination("offset")
        .fields([
            str_field("id", vec![opt_id(), opt_readonly()]),
            str_field(
                "email",
                vec![
                    opt_desc("Primary contact address"),
                    opt_format("email"),
                    opt_filterable(),
                ],
            ),
            str_field("name", vec![opt_min(2), opt_max(80)]),
            enum_field(
                "status",
                vec![
                    opt_values(["inactive", "active", "banned"]),
                    opt_filterable(),
                ],
            ),
            int_field("loginCount", vec![opt_min(0), opt_readonly()]),
            list_field("tags", vec![opt_item(str_field("tags", vec![]))]),
            obj_field(
                "profile",
                vec![
                    opt_sub([str_field("bio", vec![opt_max(500), opt_optional()])]),
                    opt_optional(),
                ],
            ),
            datetime_field("birthday", vec![opt_nullable(), opt_optional()]),
            float_field("score", vec![opt_min(0), opt_optional()]),
            bool_field("active", vec![opt_optional()]),
            str_field(
                "secretNote",
                vec![opt_max(100), opt_writeonly(), opt_optional()],
            ),
        ])
        .actions([
            act("activate")
                .desc("Move a dormant account back to active")
                .transition("status", "inactive", "active")
                .input([str_field("reason", vec![opt_max(200), opt_optional()])])
                .build(),
            act("ping").build(),
        ])
        .secure(security)
        .build()
        .expect("user_spec validation failed")
}

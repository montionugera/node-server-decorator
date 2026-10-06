use crate::patterns::{EMAIL_PATTERN, URI_PATTERN, UUID_PATTERN};
use serde_json::{json, Map, Value};
use server_decorator_entity::canonical::canonicalize_value;
use server_decorator_entity::spec::{EntitySpec, FieldSpec, SchemeSpec};
use std::collections::BTreeSet;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpenApiError {
    #[error("{entity}: no field with role \"id\"")]
    MissingIdField { entity: String },
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

fn base_type(t: &str) -> &'static str {
    match t {
        "str" | "ref" | "enum" => "string",
        "int" => "integer",
        "float" => "number",
        "bool" => "boolean",
        "datetime" => "string",
        "list" => "array",
        "obj" => "object",
        _ => "string",
    }
}

fn format_pattern(fmt: &str) -> Option<&'static str> {
    match fmt {
        "email" => Some(EMAIL_PATTERN),
        "uuid" => Some(UUID_PATTERN),
        "uri" => Some(URI_PATTERN),
        _ => None,
    }
}

pub fn json_schema_for_field(
    f: &FieldSpec,
    keep: &dyn Fn(&FieldSpec) -> bool,
) -> Result<Map<String, Value>, OpenApiError> {
    let mut s = Map::new();

    let bt = base_type(&f.r#type);
    if f.nullable {
        s.insert("type".into(), json!([bt, "null"]));
    } else {
        s.insert("type".into(), json!(bt));
    }

    if let Some(ref fmt) = f.format {
        s.insert("format".into(), json!(fmt));
        if let Some(p) = format_pattern(fmt) {
            s.insert("pattern".into(), json!(p));
        }
    } else if f.r#type == "datetime" {
        s.insert("format".into(), json!("date-time"));
    }

    if let Some(ref p) = f.pattern {
        s.insert("pattern".into(), json!(p));
    }

    if f.r#type == "str" || f.r#type == "ref" {
        if let Some(min) = f.min {
            s.insert("minLength".into(), json!(min));
        }
        if let Some(max) = f.max {
            s.insert("maxLength".into(), json!(max));
        }
    }

    if f.r#type == "int" || f.r#type == "float" {
        if let Some(min) = f.min {
            s.insert("minimum".into(), json!(min));
        }
        if let Some(max) = f.max {
            s.insert("maximum".into(), json!(max));
        }
    }

    if f.r#type == "enum" {
        if let Some(ref vs) = f.enum_values {
            s.insert("enum".into(), json!(vs));
        }
    }

    if f.r#type == "list" {
        if let Some(ref item) = f.item {
            let item_schema = json_schema_for_field(item, keep)?;
            s.insert("items".into(), Value::Object(item_schema));
        } else {
            s.insert("items".into(), json!({}));
        }
        if let Some(min) = f.min {
            s.insert("minItems".into(), json!(min));
        }
        if let Some(max) = f.max {
            s.insert("maxItems".into(), json!(max));
        }
    }

    if f.r#type == "obj" {
        let mut props = Map::new();
        let mut required = Vec::new();
        if let Some(ref fields) = f.fields {
            for sub in fields {
                if keep(sub) {
                    let sub_s = json_schema_for_field(sub, keep)?;
                    props.insert(sub.name.clone(), Value::Object(sub_s));
                    if !sub.optional {
                        required.push(json!(sub.name));
                    }
                }
            }
        }
        s.insert("type".into(), json!("object"));
        s.insert("properties".into(), Value::Object(props));
        if !required.is_empty() {
            s.insert("required".into(), json!(required));
        }
        s.insert("additionalProperties".into(), json!(false));
    }

    if let Some(ref d) = f.description {
        s.insert("description".into(), json!(d));
    }

    Ok(s)
}

fn strict_object(
    fields: &[FieldSpec],
    keep: &dyn Fn(&FieldSpec) -> bool,
) -> Result<Map<String, Value>, OpenApiError> {
    let mut props = Map::new();
    let mut required = Vec::new();

    for f in fields {
        if keep(f) {
            let sc = json_schema_for_field(f, keep)?;
            props.insert(f.name.clone(), Value::Object(sc));
            if !f.optional {
                required.push(json!(f.name));
            }
        }
    }

    let mut out = Map::new();
    out.insert("type".into(), json!("object"));
    out.insert("properties".into(), Value::Object(props));
    if !required.is_empty() {
        out.insert("required".into(), json!(required));
    }
    out.insert("additionalProperties".into(), json!(false));
    Ok(out)
}

fn list_envelope(entity_name: &str, pagination: &str) -> Map<String, Value> {
    let items = json!({
        "type": "array",
        "items": {
            "$ref": format!("#/components/schemas/{entity_name}Read")
        }
    });

    let limit = json!({
        "type": "integer",
        "minimum": 1,
        "maximum": 100
    });

    let mut out = Map::new();
    out.insert("type".into(), json!("object"));
    out.insert("additionalProperties".into(), json!(false));

    if pagination == "cursor" {
        out.insert(
            "properties".into(),
            json!({
                "items": items,
                "nextCursor": {
                    "type": ["string", "null"]
                }
            }),
        );
        out.insert("required".into(), json!(["items", "nextCursor"]));
    } else {
        out.insert(
            "properties".into(),
            json!({
                "items": items,
                "limit": limit,
                "offset": {
                    "type": "integer",
                    "minimum": 0
                },
                "total": {
                    "type": "integer",
                    "minimum": 0
                }
            }),
        );
        out.insert(
            "required".into(),
            json!(["items", "total", "limit", "offset"]),
        );
    }
    out
}

fn problem_schemas() -> Map<String, Value> {
    let problem_props = json!({
        "type": { "type": "string", "format": "uri" },
        "title": { "type": "string" },
        "status": { "type": "integer" },
        "detail": { "type": "string" },
        "instance": { "type": "string", "format": "uri" }
    });

    let mut val_props = problem_props.as_object().unwrap().clone();
    val_props.insert(
        "fields".into(),
        json!({
            "type": "array",
            "items": { "type": "string" }
        }),
    );

    let mut out = Map::new();
    out.insert(
        "Problem".into(),
        json!({
            "type": "object",
            "properties": problem_props,
            "required": ["type", "title", "status"],
            "additionalProperties": false
        }),
    );
    out.insert(
        "ValidationProblem".into(),
        json!({
            "type": "object",
            "properties": val_props,
            "required": ["type", "title", "status", "fields"],
            "additionalProperties": false
        }),
    );
    out
}

fn scheme_object(s: &SchemeSpec) -> Value {
    if s.r#type == "apiKey" {
        json!({
            "type": "apiKey",
            "in": s.r#in,
            "name": s.param_name
        })
    } else {
        let mut out = json!({
            "type": "http",
            "scheme": s.scheme
        });
        if let Some(ref bf) = s.bearer_format {
            out.as_object_mut()
                .unwrap()
                .insert("bearerFormat".into(), json!(bf));
        }
        out
    }
}

fn json_body(ref_name: &str) -> Value {
    json!({
        "content": {
            "application/json": {
                "schema": {
                    "$ref": format!("#/components/schemas/{ref_name}")
                }
            }
        }
    })
}

fn request_body(ref_name: &str) -> Value {
    let mut b = json_body(ref_name);
    b.as_object_mut()
        .unwrap()
        .insert("required".into(), json!(true));
    b
}

fn problem_response(status: &str, description: &str, component: &str) -> (String, Value) {
    (
        status.into(),
        json!({
            "description": description,
            "content": {
                "application/problem+json": {
                    "schema": {
                        "$ref": format!("#/components/schemas/{component}")
                    }
                }
            }
        }),
    )
}

fn security_for(spec: &EntitySpec, key: &str, kind: &str) -> Option<Value> {
    let sec = spec.security.as_ref()?;
    let scopes_map = if kind == "ops" {
        sec.ops.as_ref()?
    } else {
        sec.actions.as_ref()?
    };
    let scopes = scopes_map.get(key)?;
    let scheme_name = &sec.schemes.first()?.name;
    Some(json!([
        {
            scheme_name: scopes
        }
    ]))
}

#[allow(clippy::type_complexity)]
fn openapi_components(
    spec: &EntitySpec,
) -> Result<(Map<String, Value>, Map<String, Value>), OpenApiError> {
    let e = &spec.entity;
    let create = strict_object(&spec.fields, &|f| !f.readonly)?;
    let mut update = create.clone();
    update.remove("required");

    let read = strict_object(&spec.fields, &|f| !f.writeonly)?;
    let list_resp = list_envelope(e, &spec.pagination);

    let mut schemas = Map::new();
    schemas.insert(format!("{e}Create"), Value::Object(create));
    schemas.insert(format!("{e}Update"), Value::Object(update));
    schemas.insert(format!("{e}Read"), Value::Object(read));
    schemas.insert(format!("{e}ListResponse"), Value::Object(list_resp));

    if let Some(ref actions) = spec.actions {
        for a in actions {
            let input_fields = a.input.as_deref().unwrap_or(&[]);
            let act_schema = strict_object(input_fields, &|_| true)?;
            schemas.insert(
                format!("{e}{}Input", capitalize(&a.name)),
                Value::Object(act_schema),
            );
        }
    }

    let mut sec_schemes = Map::new();
    if let Some(ref sec) = spec.security {
        for s in &sec.schemes {
            sec_schemes.insert(s.name.clone(), scheme_object(s));
        }
    }

    Ok((schemas, sec_schemes))
}

fn openapi_paths(spec: &EntitySpec) -> Result<Map<String, Value>, OpenApiError> {
    let e = &spec.entity;
    let base = format!("/{}", spec.path);

    let id = spec
        .fields
        .iter()
        .find(|f| f.role.as_deref() == Some("id"))
        .ok_or_else(|| OpenApiError::MissingIdField {
            entity: spec.entity.clone(),
        })?;

    let mut id_no_role = id.clone();
    id_no_role.role = None;
    let id_schema = json_schema_for_field(&id_no_role, &|_| true)?;

    let id_param = json!({
        "name": id.name,
        "in": "path",
        "required": true,
        "schema": id_schema
    });

    let mut out = Map::new();
    let mut collection = Map::new();
    let mut item = Map::new();

    let ok200 = |ref_name: &str| -> (String, Value) {
        let mut r = json_body(ref_name);
        r.as_object_mut()
            .unwrap()
            .insert("description".into(), json!("OK"));
        ("200".into(), r)
    };

    if spec.ops.iter().any(|op| op == "list") {
        let mut params = Vec::new();

        // Pagination params
        let limit_param = json!({
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "default": 20
            }
        });

        if spec.pagination == "cursor" {
            params.push(limit_param);
            params.push(json!({
                "name": "cursor",
                "in": "query",
                "required": false,
                "schema": { "type": "string" }
            }));
        } else {
            params.push(limit_param);
            params.push(json!({
                "name": "offset",
                "in": "query",
                "required": false,
                "schema": {
                    "type": "integer",
                    "minimum": 0,
                    "default": 0
                }
            }));
        }

        // Filter params
        let mut filter_count = 0;
        for f in &spec.fields {
            if f.filterable {
                filter_count += 1;
                let mut rest = f.clone();
                rest.optional = false;
                rest.nullable = false;
                let sc = json_schema_for_field(&rest, &|_| true)?;
                params.push(json!({
                    "name": f.name,
                    "in": "query",
                    "required": false,
                    "schema": sc
                }));
            }
        }

        params.sort_by(|a, b| {
            let name_a = a["name"].as_str().unwrap_or("");
            let name_b = b["name"].as_str().unwrap_or("");
            name_a.cmp(name_b)
        });

        let mut responses = Map::new();
        let (code, resp) = ok200(&format!("{e}ListResponse"));
        responses.insert(code, resp);
        if filter_count > 0 {
            let (c, r) = problem_response("400", "Bad Request", "ValidationProblem");
            responses.insert(c, r);
        }

        let mut op = json!({
            "operationId": format!("list{e}"),
            "parameters": params,
            "responses": responses
        });
        if let Some(ref tags) = spec.tags {
            op.as_object_mut()
                .unwrap()
                .insert("tags".into(), json!(tags));
        }
        if let Some(sec) = security_for(spec, "list", "ops") {
            op.as_object_mut().unwrap().insert("security".into(), sec);
        }
        collection.insert("get".into(), op);
    }

    if spec.ops.iter().any(|op| op == "create") {
        let mut created = json_body(&format!("{e}Read"));
        created
            .as_object_mut()
            .unwrap()
            .insert("description".into(), json!("Created"));

        let mut responses = Map::new();
        responses.insert("201".into(), created);
        let (c400, r400) = problem_response("400", "Bad Request", "ValidationProblem");
        responses.insert(c400, r400);

        let mut op = json!({
            "operationId": format!("create{e}"),
            "requestBody": request_body(&format!("{e}Create")),
            "responses": responses
        });
        if let Some(ref tags) = spec.tags {
            op.as_object_mut()
                .unwrap()
                .insert("tags".into(), json!(tags));
        }
        if let Some(sec) = security_for(spec, "create", "ops") {
            op.as_object_mut().unwrap().insert("security".into(), sec);
        }
        collection.insert("post".into(), op);
    }

    if spec.ops.iter().any(|op| op == "get") {
        let mut responses = Map::new();
        let (code, resp) = ok200(&format!("{e}Read"));
        responses.insert(code, resp);
        let (c404, r404) = problem_response("404", "Not Found", "Problem");
        responses.insert(c404, r404);

        let mut op = json!({
            "operationId": format!("get{e}"),
            "parameters": [id_param.clone()],
            "responses": responses
        });
        if let Some(ref tags) = spec.tags {
            op.as_object_mut()
                .unwrap()
                .insert("tags".into(), json!(tags));
        }
        if let Some(sec) = security_for(spec, "get", "ops") {
            op.as_object_mut().unwrap().insert("security".into(), sec);
        }
        item.insert("get".into(), op);
    }

    if spec.ops.iter().any(|op| op == "update") {
        let mut responses = Map::new();
        let (code, resp) = ok200(&format!("{e}Read"));
        responses.insert(code, resp);
        let (c400, r400) = problem_response("400", "Bad Request", "ValidationProblem");
        responses.insert(c400, r400);
        let (c404, r404) = problem_response("404", "Not Found", "Problem");
        responses.insert(c404, r404);

        let mut op = json!({
            "operationId": format!("update{e}"),
            "parameters": [id_param.clone()],
            "requestBody": request_body(&format!("{e}Update")),
            "responses": responses
        });
        if let Some(ref tags) = spec.tags {
            op.as_object_mut()
                .unwrap()
                .insert("tags".into(), json!(tags));
        }
        if let Some(sec) = security_for(spec, "update", "ops") {
            op.as_object_mut().unwrap().insert("security".into(), sec);
        }
        item.insert("patch".into(), op);
    }

    if spec.ops.iter().any(|op| op == "delete") {
        let mut responses = Map::new();
        responses.insert("204".into(), json!({ "description": "No Content" }));
        let (c404, r404) = problem_response("404", "Not Found", "Problem");
        responses.insert(c404, r404);

        let mut op = json!({
            "operationId": format!("delete{e}"),
            "parameters": [id_param.clone()],
            "responses": responses
        });
        if let Some(ref tags) = spec.tags {
            op.as_object_mut()
                .unwrap()
                .insert("tags".into(), json!(tags));
        }
        if let Some(sec) = security_for(spec, "delete", "ops") {
            op.as_object_mut().unwrap().insert("security".into(), sec);
        }
        item.insert("delete".into(), op);
    }

    if !collection.is_empty() {
        out.insert(base.clone(), Value::Object(collection));
    }
    if !item.is_empty() {
        out.insert(format!("{base}/{{{}}}", id.name), Value::Object(item));
    }

    if let Some(ref actions) = spec.actions {
        for a in actions {
            let mut responses = Map::new();
            let (code, resp) = ok200(&format!("{e}Read"));
            responses.insert(code, resp);
            let (c400, r400) = problem_response("400", "Bad Request", "ValidationProblem");
            responses.insert(c400, r400);
            let (c404, r404) = problem_response("404", "Not Found", "Problem");
            responses.insert(c404, r404);
            if a.from.is_some() {
                let (c409, r409) = problem_response("409", "Conflict", "Problem");
                responses.insert(c409, r409);
            }

            let mut post_op = json!({
                "operationId": format!("{}{e}", a.name),
                "parameters": [id_param.clone()],
                "requestBody": request_body(&format!("{e}{}Input", capitalize(&a.name))),
                "responses": responses
            });

            if let Some(ref d) = a.description {
                post_op
                    .as_object_mut()
                    .unwrap()
                    .insert("description".into(), json!(d));
            }
            if let Some(ref tags) = spec.tags {
                post_op
                    .as_object_mut()
                    .unwrap()
                    .insert("tags".into(), json!(tags));
            }
            if let Some(sec) = security_for(spec, &a.name, "actions") {
                post_op
                    .as_object_mut()
                    .unwrap()
                    .insert("security".into(), sec);
            }

            let action_path = format!("{base}/{{{}}}/actions/{}", id.name, a.name);
            let mut post_map = Map::new();
            post_map.insert("post".into(), post_op);
            out.insert(action_path, Value::Object(post_map));
        }
    }

    Ok(out)
}

pub fn generate(specs: &[EntitySpec], version: &str) -> Result<String, OpenApiError> {
    let mut schemas = problem_schemas();
    let mut security_schemes = Map::new();
    let mut paths = Map::new();
    let mut tag_set = BTreeSet::new();

    for spec in specs {
        let (s, sec) = openapi_components(spec)?;
        for (k, v) in s {
            schemas.insert(k, v);
        }
        for (k, v) in sec {
            security_schemes.insert(k, v);
        }
        let p = openapi_paths(spec)?;
        for (k, v) in p {
            paths.insert(k, v);
        }
        if let Some(ref tags) = spec.tags {
            for t in tags {
                tag_set.insert(t.clone());
            }
        }
    }

    let mut components = Map::new();
    components.insert("schemas".into(), Value::Object(schemas));
    if !security_schemes.is_empty() {
        components.insert("securitySchemes".into(), Value::Object(security_schemes));
    }

    let mut doc = Map::new();
    doc.insert("openapi".into(), json!("3.1.0"));
    doc.insert(
        "info".into(),
        json!({
            "title": "server-decorator API",
            "version": version
        }),
    );
    doc.insert("paths".into(), Value::Object(paths));
    doc.insert("components".into(), Value::Object(components));

    if !tag_set.is_empty() {
        let tags: Vec<Value> = tag_set.into_iter().map(|t| json!({ "name": t })).collect();
        doc.insert("tags".into(), Value::Array(tags));
    }

    let canonical = canonicalize_value(Value::Object(doc));
    let s = serde_json::to_string(&canonical)?;
    Ok(s)
}

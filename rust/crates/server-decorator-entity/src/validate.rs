use crate::spec::{EntitySpec, FieldSpec, SecuritySpec};
use std::collections::HashSet;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("{entity}: transports must not be empty")]
    EmptyTransports { entity: String },
    #[error("{entity}: ops must not be empty")]
    EmptyOps { entity: String },
    #[error("field \"{path}\": wire name \"{name}\" is reserved (shadows a pydantic BaseModel attribute)")]
    ReservedWireName { path: String, name: String },
    #[error("field \"{path}\": format and pattern are mutually exclusive")]
    FormatAndPatternMutuallyExclusive { path: String },
    #[error("field \"{path}\": pattern \"{pattern}\" is not RE2/rust-regex compatible (contains lookaround \"{marker}\") — see contracts/rules/entity-spec-validation.md")]
    LookaroundInPattern {
        path: String,
        pattern: String,
        marker: String,
    },
    #[error("field \"{path}\": pattern \"{pattern}\" is not RE2/rust-regex compatible (contains a backreference) — see contracts/rules/entity-spec-validation.md")]
    BackreferenceInPattern { path: String, pattern: String },
    #[error("field \"{path}\": enum must have at least one value")]
    EmptyEnum { path: String },
    #[error("{entity}: security.schemes must not be empty")]
    EmptySecuritySchemes { entity: String },
    #[error("{entity}: scheme \"{name}\": type must be \"http\" or \"apiKey\"")]
    InvalidSchemeType { entity: String, name: String },
    #[error("{entity}: scheme \"{name}\": http requires \"scheme\"")]
    MissingHttpScheme { entity: String, name: String },
    #[error("{entity}: scheme \"{name}\": apiKey requires \"in\" and \"paramName\"")]
    MissingApiKeyFields { entity: String, name: String },
    #[error("{entity}: security.ops.{op} is not declared in ops")]
    SecurityOpNotDeclared { entity: String, op: String },
    #[error("{entity}: security.actions.{action} is not a declared action")]
    SecurityActionNotDeclared { entity: String, action: String },
}

pub fn reserved_wire_names() -> HashSet<&'static str> {
    [
        "construct",
        "copy",
        "dict",
        "from_orm",
        "json",
        "model_computed_fields",
        "model_config",
        "model_construct",
        "model_copy",
        "model_dump",
        "model_dump_json",
        "model_extra",
        "model_fields",
        "model_fields_set",
        "model_json_schema",
        "model_parametrized_name",
        "model_post_init",
        "model_rebuild",
        "model_validate",
        "model_validate_json",
        "model_validate_strings",
        "parse_file",
        "parse_obj",
        "parse_raw",
        "schema",
        "schema_json",
        "update_forward_refs",
        "validate",
    ]
    .into_iter()
    .collect()
}

const LOOKAROUND_MARKERS: [&str; 4] = ["(?=", "(?!", "(?<=", "(?<!"];

fn has_backreference(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    for i in 0..bytes.len() {
        let c = bytes[i];
        if (b'1'..=b'9').contains(&c) {
            let mut backslashes = 0;
            let mut j = i as isize - 1;
            while j >= 0 && bytes[j as usize] == b'\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 1 {
                return true;
            }
        }
    }
    false
}

pub fn validate_field(f: &FieldSpec, path: &str) -> Result<(), ValidationError> {
    let reserved = reserved_wire_names();
    if reserved.contains(f.name.as_str()) {
        return Err(ValidationError::ReservedWireName {
            path: path.to_string(),
            name: f.name.clone(),
        });
    }

    if f.format.is_some() && f.pattern.is_some() {
        return Err(ValidationError::FormatAndPatternMutuallyExclusive {
            path: path.to_string(),
        });
    }

    if let Some(ref p) = f.pattern {
        for marker in LOOKAROUND_MARKERS {
            if p.contains(marker) {
                return Err(ValidationError::LookaroundInPattern {
                    path: path.to_string(),
                    pattern: p.clone(),
                    marker: marker.to_string(),
                });
            }
        }
        if has_backreference(p) {
            return Err(ValidationError::BackreferenceInPattern {
                path: path.to_string(),
                pattern: p.clone(),
            });
        }
    }

    if let Some(ref enum_vals) = f.enum_values {
        if enum_vals.is_empty() {
            return Err(ValidationError::EmptyEnum {
                path: path.to_string(),
            });
        }
    }

    if let Some(ref item) = f.item {
        validate_field(item, &format!("{path}.item"))?;
    }

    if let Some(ref nested_fields) = f.fields {
        for nested in nested_fields {
            validate_field(nested, &format!("{path}.{}", nested.name))?;
        }
    }

    Ok(())
}

pub fn validate_security(
    sec: &SecuritySpec,
    ops: &[String],
    action_names: &[String],
    entity: &str,
) -> Result<(), ValidationError> {
    if sec.schemes.is_empty() {
        return Err(ValidationError::EmptySecuritySchemes {
            entity: entity.to_string(),
        });
    }

    for s in &sec.schemes {
        if s.r#type != "http" && s.r#type != "apiKey" {
            return Err(ValidationError::InvalidSchemeType {
                entity: entity.to_string(),
                name: s.name.clone(),
            });
        }
        if s.r#type == "http" && s.scheme.is_none() {
            return Err(ValidationError::MissingHttpScheme {
                entity: entity.to_string(),
                name: s.name.clone(),
            });
        }
        if s.r#type == "apiKey" && (s.r#in.is_none() || s.param_name.is_none()) {
            return Err(ValidationError::MissingApiKeyFields {
                entity: entity.to_string(),
                name: s.name.clone(),
            });
        }
    }

    if let Some(ref sec_ops) = sec.ops {
        for op in sec_ops.keys() {
            if !ops.contains(op) {
                return Err(ValidationError::SecurityOpNotDeclared {
                    entity: entity.to_string(),
                    op: op.clone(),
                });
            }
        }
    }

    if let Some(ref sec_actions) = sec.actions {
        for action in sec_actions.keys() {
            if !action_names.contains(action) {
                return Err(ValidationError::SecurityActionNotDeclared {
                    entity: entity.to_string(),
                    action: action.clone(),
                });
            }
        }
    }

    Ok(())
}

pub fn validate_entity_spec(spec: &EntitySpec) -> Result<(), ValidationError> {
    if spec.transports.is_empty() {
        return Err(ValidationError::EmptyTransports {
            entity: spec.entity.clone(),
        });
    }
    if spec.ops.is_empty() {
        return Err(ValidationError::EmptyOps {
            entity: spec.entity.clone(),
        });
    }

    for f in &spec.fields {
        validate_field(f, &f.name)?;
    }

    let mut action_names = Vec::new();
    if let Some(ref actions) = spec.actions {
        for a in actions {
            action_names.push(a.name.clone());
            if let Some(ref inputs) = a.input {
                for f in inputs {
                    validate_field(f, &format!("{}.{}", a.name, f.name))?;
                }
            }
        }
    }

    if let Some(ref sec) = spec.security {
        validate_security(sec, &spec.ops, &action_names, &spec.entity)?;
    }

    Ok(())
}

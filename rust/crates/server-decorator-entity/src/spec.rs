use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SPEC_VERSION: &str = "1.2.0";

/// Field represents an entity field, nested object field, list item, or action input.
/// Fields are declared in ascending order of JSON keys for canonical serialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<FieldSpec>>,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub filterable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<Box<FieldSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub nullable: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub optional: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub readonly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub r#type: String,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub writeonly: bool,
}

/// Action represents a named entity action, optionally a state transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<FieldSpec>>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transactional: Option<bool>,
}

/// Scheme represents one security scheme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemeSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearer_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#in: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    pub r#type: String,
}

/// SecuritySpec maps ops and actions to required scopes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<BTreeMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops: Option<BTreeMap<String, Vec<String>>>,
    pub schemes: Vec<SchemeSpec>,
}

/// EntitySpec is the canonical EntitySpec IR document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ActionSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub entity: String,
    pub fields: Vec<FieldSpec>,
    pub ops: Vec<String>,
    pub pagination: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<SecuritySpec>,
    pub spec_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    pub transports: Vec<String>,
}

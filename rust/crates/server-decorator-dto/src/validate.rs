use regex::Regex;
use serde_json::Value;
use server_decorator_entity::spec::{EntitySpec, FieldSpec};
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$").unwrap()
});

static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        .unwrap()
});

static URI_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$").unwrap());

static DATETIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$").unwrap()
});

type IncludePredicate = fn(&FieldSpec) -> bool;

fn not_readonly(f: &FieldSpec) -> bool {
    !f.readonly
}

fn not_writeonly(f: &FieldSpec) -> bool {
    !f.writeonly
}

fn include_all(_f: &FieldSpec) -> bool {
    true
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

pub fn validate(spec: &EntitySpec, dto_type: &str, payload: &Value) -> (Vec<String>, bool) {
    let target_fields: Vec<FieldSpec>;
    let include: IncludePredicate;

    match dto_type {
        "create" => {
            include = not_readonly;
            target_fields = spec.fields.iter().filter(|f| include(f)).cloned().collect();
        }
        "update" => {
            include = not_readonly;
            let filtered: Vec<FieldSpec> =
                spec.fields.iter().filter(|f| include(f)).cloned().collect();
            target_fields = filtered
                .into_iter()
                .map(|mut f| {
                    f.optional = true;
                    f
                })
                .collect();
        }
        "read" => {
            include = not_writeonly;
            target_fields = spec.fields.iter().filter(|f| include(f)).cloned().collect();
        }
        _ if dto_type.starts_with("action:") => {
            let action_name = &dto_type["action:".len()..];
            let found = spec
                .actions
                .as_ref()
                .and_then(|acts| acts.iter().find(|a| a.name == action_name));
            match found {
                Some(a) => {
                    include = include_all;
                    target_fields = a.input.clone().unwrap_or_default();
                }
                None => return (vec!["_action".into()], false),
            }
        }
        _ => return (vec!["_dto".into()], false),
    }

    let mut err_set = BTreeSet::new();
    validate_object(&target_fields, payload, "", include, &mut err_set);

    let err_list: Vec<String> = err_set.into_iter().collect();
    let is_valid = err_list.is_empty();
    (err_list, is_valid)
}

fn validate_object(
    fields: &[FieldSpec],
    payload: &Value,
    current_path: &str,
    include: IncludePredicate,
    err_set: &mut BTreeSet<String>,
) {
    let obj_map = match payload.as_object() {
        Some(m) => m,
        None => {
            if !current_path.is_empty() {
                err_set.insert(current_path.to_string());
            } else {
                err_set.insert("_root".to_string());
            }
            return;
        }
    };

    let field_by_name: HashMap<&str, &FieldSpec> =
        fields.iter().map(|f| (f.name.as_str(), f)).collect();

    // 1. Strict object check: reject unknown keys
    for k in obj_map.keys() {
        if !field_by_name.contains_key(k.as_str()) {
            err_set.insert(join_path(current_path, k));
        }
    }

    // 2. Validate declared fields
    for f in fields {
        let f_path = join_path(current_path, &f.name);
        match obj_map.get(&f.name) {
            None => {
                if !f.optional {
                    err_set.insert(f_path);
                }
            }
            Some(Value::Null) => {
                if !f.nullable {
                    err_set.insert(f_path);
                }
            }
            Some(val) => {
                validate_field_value(f, val, &f_path, include, err_set);
            }
        }
    }
}

fn validate_field_value(
    f: &FieldSpec,
    val: &Value,
    path: &str,
    include: IncludePredicate,
    err_set: &mut BTreeSet<String>,
) {
    match f.r#type.as_str() {
        "str" | "ref" => validate_string(f, val, path, err_set),
        "int" => validate_int(f, val, path, err_set),
        "float" => validate_float(f, val, path, err_set),
        "bool" => validate_bool(val, path, err_set),
        "datetime" => validate_datetime(val, path, err_set),
        "enum" => validate_enum(f, val, path, err_set),
        "list" => validate_list(f, val, path, include, err_set),
        "obj" => validate_obj(f, val, path, include, err_set),
        _ => {
            err_set.insert(path.to_string());
        }
    }
}

fn validate_string(f: &FieldSpec, val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    let s = match val.as_str() {
        Some(s) => s,
        None => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if let Some(min) = f.min {
        if (s.chars().count() as i64) < min {
            err_set.insert(path.to_string());
            return;
        }
    }
    if let Some(max) = f.max {
        if (s.chars().count() as i64) > max {
            err_set.insert(path.to_string());
            return;
        }
    }

    if let Some(ref fmt) = f.format {
        match fmt.as_str() {
            "email" if !EMAIL_RE.is_match(s) => {
                err_set.insert(path.to_string());
            }
            "uuid" if !UUID_RE.is_match(s) => {
                err_set.insert(path.to_string());
            }
            "uri" if !URI_RE.is_match(s) => {
                err_set.insert(path.to_string());
            }
            _ => {}
        }
    } else if let Some(ref p) = f.pattern {
        let rewritten = ascii_classes(p);
        if let Ok(re) = Regex::new(&rewritten) {
            if !re.is_match(s) {
                err_set.insert(path.to_string());
            }
        } else {
            err_set.insert(path.to_string());
        }
    }
}

fn ascii_classes(pattern: &str) -> String {
    let mut out = String::new();
    let mut in_class = false;
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let nxt = chars[i + 1];
            match nxt {
                'd' => {
                    if in_class {
                        out.push_str("0-9");
                    } else {
                        out.push_str("[0-9]");
                    }
                }
                'D' => {
                    out.push_str("[^0-9]");
                }
                'w' => {
                    if in_class {
                        out.push_str("0-9A-Za-z_");
                    } else {
                        out.push_str("[0-9A-Za-z_]");
                    }
                }
                'W' => {
                    out.push_str("[^0-9A-Za-z_]");
                }
                'b' | 'B' => {
                    if !in_class {
                        out.push_str(&format!("(?-u:\\{nxt})"));
                    } else {
                        out.push('\\');
                        out.push(nxt);
                    }
                }
                _ => {
                    out.push(c);
                    out.push(nxt);
                }
            }
            i += 2;
            continue;
        }
        if c == '[' && !in_class {
            in_class = true;
        } else if c == ']' && in_class {
            in_class = false;
        }
        out.push(c);
        i += 1;
    }
    out
}

fn validate_int(f: &FieldSpec, val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    let num = match val {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i
            } else if let Some(fl) = n.as_f64() {
                if fl.fract() == 0.0 {
                    fl as i64
                } else {
                    err_set.insert(path.to_string());
                    return;
                }
            } else {
                err_set.insert(path.to_string());
                return;
            }
        }
        _ => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if let Some(min) = f.min {
        if num < min {
            err_set.insert(path.to_string());
        }
    }
    if let Some(max) = f.max {
        if num > max {
            err_set.insert(path.to_string());
        }
    }
}

fn validate_float(f: &FieldSpec, val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    let fl = match val {
        Value::Number(n) => match n.as_f64() {
            Some(f) => f,
            None => {
                err_set.insert(path.to_string());
                return;
            }
        },
        _ => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if let Some(min) = f.min {
        if fl < (min as f64) {
            err_set.insert(path.to_string());
        }
    }
    if let Some(max) = f.max {
        if fl > (max as f64) {
            err_set.insert(path.to_string());
        }
    }
}

fn validate_bool(val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    if !val.is_boolean() {
        err_set.insert(path.to_string());
    }
}

fn validate_datetime(val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    let s = match val.as_str() {
        Some(s) => s,
        None => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if !DATETIME_RE.is_match(s) || chrono::DateTime::parse_from_rfc3339(s).is_err() {
        err_set.insert(path.to_string());
    }
}

fn validate_enum(f: &FieldSpec, val: &Value, path: &str, err_set: &mut BTreeSet<String>) {
    let s = match val.as_str() {
        Some(s) => s,
        None => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if let Some(ref allowed) = f.enum_values {
        if !allowed.iter().any(|a| a == s) {
            err_set.insert(path.to_string());
        }
    }
}

fn validate_list(
    f: &FieldSpec,
    val: &Value,
    path: &str,
    include: IncludePredicate,
    err_set: &mut BTreeSet<String>,
) {
    let arr = match val.as_array() {
        Some(a) => a,
        None => {
            err_set.insert(path.to_string());
            return;
        }
    };

    if let Some(ref item) = f.item {
        for (i, elem) in arr.iter().enumerate() {
            let item_path = format!("{path}.{i}");
            if elem.is_null() {
                if !item.nullable {
                    err_set.insert(item_path);
                }
            } else {
                validate_field_value(item, elem, &item_path, include, err_set);
            }
        }
    }
}

fn validate_obj(
    f: &FieldSpec,
    val: &Value,
    path: &str,
    include: IncludePredicate,
    err_set: &mut BTreeSet<String>,
) {
    let nested: Vec<FieldSpec> = f
        .fields
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|sub| include(sub))
        .cloned()
        .collect();
    validate_object(&nested, val, path, include, err_set);
}

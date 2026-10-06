use crate::spec::{ActionSpec, EntitySpec, FieldSpec, SecuritySpec, SPEC_VERSION};
use crate::validate::validate_entity_spec;

pub struct EntityBuilder {
    spec: EntitySpec,
}

impl EntityBuilder {
    pub fn new(entity: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            spec: EntitySpec {
                actions: None,
                description: None,
                entity: entity.into(),
                fields: Vec::new(),
                ops: vec![
                    "list".into(),
                    "get".into(),
                    "create".into(),
                    "update".into(),
                    "delete".into(),
                ],
                pagination: "offset".into(),
                path: path.into(),
                security: None,
                spec_version: SPEC_VERSION.into(),
                tags: None,
                transports: vec!["rest".into()],
            },
        }
    }

    pub fn desc(mut self, d: impl Into<String>) -> Self {
        self.spec.description = Some(d.into());
        self
    }

    pub fn tags<I, S>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.spec.tags = Some(tags.into_iter().map(Into::into).collect());
        self
    }

    pub fn transports<I, S>(mut self, ts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.spec.transports = ts.into_iter().map(Into::into).collect();
        self
    }

    pub fn ops<I, S>(mut self, ops: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.spec.ops = ops.into_iter().map(Into::into).collect();
        self
    }

    pub fn pagination(mut self, p: impl Into<String>) -> Self {
        self.spec.pagination = p.into();
        self
    }

    pub fn fields(mut self, fs: impl IntoIterator<Item = FieldSpec>) -> Self {
        self.spec.fields = fs.into_iter().collect();
        self
    }

    pub fn actions(mut self, acts: impl IntoIterator<Item = ActionSpec>) -> Self {
        self.spec.actions = Some(acts.into_iter().collect());
        self
    }

    pub fn secure(mut self, sec: SecuritySpec) -> Self {
        self.spec.security = Some(sec);
        self
    }

    pub fn build(self) -> Result<EntitySpec, crate::validate::ValidationError> {
        validate_entity_spec(&self.spec)?;
        Ok(self.spec)
    }
}

pub struct ActionBuilder {
    action: ActionSpec,
}

impl ActionBuilder {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            action: ActionSpec {
                description: None,
                from: None,
                input: None,
                name: name.into(),
                state_field: None,
                to: None,
                transactional: None,
            },
        }
    }

    pub fn desc(mut self, d: impl Into<String>) -> Self {
        self.action.description = Some(d.into());
        self
    }

    pub fn input(mut self, fs: impl IntoIterator<Item = FieldSpec>) -> Self {
        self.action.input = Some(fs.into_iter().collect());
        self
    }

    pub fn transition(
        mut self,
        state_field: impl Into<String>,
        from: impl Into<String>,
        to: impl Into<String>,
    ) -> Self {
        self.action.state_field = Some(state_field.into());
        self.action.from = Some(from.into());
        self.action.to = Some(to.into());
        self
    }

    pub fn non_transactional(mut self) -> Self {
        self.action.transactional = Some(false);
        self
    }

    pub fn build(self) -> ActionSpec {
        self.action
    }
}

pub fn act(name: impl Into<String>) -> ActionBuilder {
    ActionBuilder::new(name)
}

pub type FieldOpt = Box<dyn FnOnce(&mut FieldSpec)>;

pub fn opt_id() -> FieldOpt {
    Box::new(|f| f.role = Some("id".into()))
}

pub fn opt_readonly() -> FieldOpt {
    Box::new(|f| f.readonly = true)
}

pub fn opt_writeonly() -> FieldOpt {
    Box::new(|f| f.writeonly = true)
}

pub fn opt_optional() -> FieldOpt {
    Box::new(|f| f.optional = true)
}

pub fn opt_nullable() -> FieldOpt {
    Box::new(|f| f.nullable = true)
}

pub fn opt_filterable() -> FieldOpt {
    Box::new(|f| f.filterable = true)
}

pub fn opt_desc(d: impl Into<String>) -> FieldOpt {
    let d = d.into();
    Box::new(move |f| f.description = Some(d))
}

pub fn opt_format(fmt: impl Into<String>) -> FieldOpt {
    let fmt = fmt.into();
    Box::new(move |f| f.format = Some(fmt))
}

pub fn opt_pattern(p: impl Into<String>) -> FieldOpt {
    let p = p.into();
    Box::new(move |f| f.pattern = Some(p))
}

pub fn opt_min(n: i64) -> FieldOpt {
    Box::new(move |f| f.min = Some(n))
}

pub fn opt_max(n: i64) -> FieldOpt {
    Box::new(move |f| f.max = Some(n))
}

pub fn opt_values<I, S>(vs: I) -> FieldOpt
where
    I: IntoIterator<Item = S> + 'static,
    S: Into<String>,
{
    Box::new(move |f| f.enum_values = Some(vs.into_iter().map(Into::into).collect()))
}

pub fn opt_item(item: FieldSpec) -> FieldOpt {
    Box::new(move |f| f.item = Some(Box::new(item)))
}

pub fn opt_sub<I>(fields: I) -> FieldOpt
where
    I: IntoIterator<Item = FieldSpec> + 'static,
{
    Box::new(move |f| f.fields = Some(fields.into_iter().collect()))
}

fn build_field(name: impl Into<String>, typ: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    let mut f = FieldSpec {
        description: None,
        enum_values: None,
        fields: None,
        filterable: false,
        format: None,
        item: None,
        max: None,
        min: None,
        name: name.into(),
        nullable: false,
        optional: false,
        pattern: None,
        readonly: false,
        r#ref: None,
        role: None,
        r#type: typ.into(),
        writeonly: false,
    };
    for opt in opts {
        opt(&mut f);
    }
    f
}

pub fn str_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "str", opts)
}

pub fn int_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "int", opts)
}

pub fn float_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "float", opts)
}

pub fn bool_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "bool", opts)
}

pub fn datetime_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "datetime", opts)
}

pub fn enum_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "enum", opts)
}

pub fn list_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "list", opts)
}

pub fn obj_field(name: impl Into<String>, opts: Vec<FieldOpt>) -> FieldSpec {
    build_field(name, "obj", opts)
}

pub fn ref_field(
    name: impl Into<String>,
    target: impl Into<String>,
    opts: Vec<FieldOpt>,
) -> FieldSpec {
    let target = target.into();
    let mut f = build_field(name, "ref", opts);
    f.r#ref = Some(target);
    f
}

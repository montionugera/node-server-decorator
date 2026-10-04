package entity

import (
	"fmt"
	"regexp"
)

// wireNameRe is the field-name pattern of contracts/schemas/entity-spec.schema.json.
var wireNameRe = regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`)

// reservedWireNames mirrors RESERVED_WIRE_NAMES in node/packages/entity/src/validate.ts and
// server_decorator_entity.validate (public pydantic.BaseModel attribute names) — see "Reserved
// wire names" in contracts/rules/entity-spec-validation.md.
var reservedWireNames = map[string]bool{
	"construct": true, "copy": true, "dict": true, "from_orm": true, "json": true,
	"model_computed_fields": true, "model_config": true, "model_construct": true,
	"model_copy": true, "model_dump": true, "model_dump_json": true, "model_extra": true,
	"model_fields": true, "model_fields_set": true, "model_json_schema": true,
	"model_parametrized_name": true, "model_post_init": true, "model_rebuild": true,
	"model_validate": true, "model_validate_json": true, "model_validate_strings": true,
	"parse_file": true, "parse_obj": true, "parse_raw": true, "schema": true,
	"schema_json": true, "update_forward_refs": true, "validate": true,
}

// validateField rejects a field ParseStruct derived from Go source that would not be valid
// EntitySpec IR, recursing into list items and nested obj fields. It mirrors validateField in
// node/packages/entity/src/validate.ts, plus the schema's wire-name pattern (which a Go field
// name or a json tag such as `user_name` can violate).
func validateField(f Field, path string) error {
	if !wireNameRe.MatchString(f.Name) {
		return fmt.Errorf("field %q: wire name %q must match ^[a-z][A-Za-z0-9]*$ (set one with an entity tag)", path, f.Name)
	}
	if reservedWireNames[f.Name] {
		return fmt.Errorf("field %q: wire name %q is reserved (shadows a pydantic BaseModel attribute)", path, f.Name)
	}
	if f.Format != "" && f.Pattern != "" {
		return fmt.Errorf("field %q: format and pattern are mutually exclusive", path)
	}
	if f.Type == "enum" && len(f.Enum) == 0 {
		return fmt.Errorf("field %q: enum must have at least one value", path)
	}
	if f.Item != nil {
		if err := validateField(*f.Item, path+".item"); err != nil {
			return err
		}
	}
	for _, nested := range f.Fields {
		if err := validateField(nested, path+"."+nested.Name); err != nil {
			return err
		}
	}
	return nil
}

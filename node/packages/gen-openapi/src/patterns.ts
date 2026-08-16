// Copied from contracts/rules/entity-spec-validation.md, not imported: this package must not
// depend on gen-zod (layering rule — entity -> gen-* -> adapters, never gen-* -> gen-*).
// Keep byte-identical to gen-zod's map-field.ts and to gen_openapi's patterns.py.

// WHATWG HTML5 email pattern. `format: "email"` MUST validate against this exact regex, not
// either ecosystem's built-in email validator (pydantic's EmailStr accepts `a@b.c`, zod's
// .email() rejects it).
export const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

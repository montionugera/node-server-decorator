import * as barrel from './index';
import { jsonSchemaForField, objectProperties } from './map-field';
import { EMAIL_PATTERN, UUID_PATTERN, URI_PATTERN } from './patterns';
import { openapiComponents, capitalize, PROBLEM_SCHEMAS } from './components';
import { openapiPaths } from './paths';
import { openapiDocument } from './document';

describe('gen-openapi public barrel', () => {
  it('exposes exactly the documented runtime surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'EMAIL_PATTERN',
        'PROBLEM_SCHEMAS',
        'URI_PATTERN',
        'UUID_PATTERN',
        'capitalize',
        'jsonSchemaForField',
        'objectProperties',
        'openapiComponents',
        'openapiDocument',
        'openapiPaths',
      ].sort()
    );
  });

  it('re-exports the same bindings as the submodules, not copies', () => {
    expect(barrel.jsonSchemaForField).toBe(jsonSchemaForField);
    expect(barrel.objectProperties).toBe(objectProperties);
    expect(barrel.EMAIL_PATTERN).toBe(EMAIL_PATTERN);
    expect(barrel.UUID_PATTERN).toBe(UUID_PATTERN);
    expect(barrel.URI_PATTERN).toBe(URI_PATTERN);
    expect(barrel.openapiComponents).toBe(openapiComponents);
    expect(barrel.capitalize).toBe(capitalize);
    expect(barrel.PROBLEM_SCHEMAS).toBe(PROBLEM_SCHEMAS);
    expect(barrel.openapiPaths).toBe(openapiPaths);
    expect(barrel.openapiDocument).toBe(openapiDocument);
  });

  it('is usable end to end through the barrel alone', () => {
    expect(barrel.capitalize('user')).toBe('User');
    expect(barrel.EMAIL_PATTERN.test('a.b@example.co')).toBe(true);
    expect(barrel.EMAIL_PATTERN.test('no-at-sign')).toBe(false);
    expect(barrel.UUID_PATTERN.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(barrel.URI_PATTERN.test('example.com')).toBe(false);
    expect(Object.keys(barrel.PROBLEM_SCHEMAS).length).toBeGreaterThan(0);
  });
});

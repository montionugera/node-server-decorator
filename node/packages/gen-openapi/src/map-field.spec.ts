import { FieldSpec } from '@montionugera/entity-spec';
import { jsonSchemaForField } from './map-field';

describe('jsonSchemaForField', () => {
  it('maps scalars', () => {
    expect(jsonSchemaForField({ name: 'a', type: 'int', min: 0, max: 9 }))
      .toEqual({ type: 'integer', minimum: 0, maximum: 9 });
    expect(jsonSchemaForField({ name: 'b', type: 'float' })).toEqual({ type: 'number' });
    expect(jsonSchemaForField({ name: 'c', type: 'bool' })).toEqual({ type: 'boolean' });
    expect(jsonSchemaForField({ name: 'd', type: 'datetime' }))
      .toEqual({ type: 'string', format: 'date-time' });
  });

  it('maps string constraints to length keywords', () => {
    expect(jsonSchemaForField({ name: 'n', type: 'str', min: 2, max: 80 }))
      .toEqual({ type: 'string', minLength: 2, maxLength: 80 });
  });

  it('emits both format and pattern for email', () => {
    const s = jsonSchemaForField({ name: 'e', type: 'str', format: 'email' }) as
      Record<string, unknown>;
    expect(s.format).toBe('email');
    expect(typeof s.pattern).toBe('string');
  });

  it('renders nullable as a type array', () => {
    expect(jsonSchemaForField({ name: 'b', type: 'datetime', nullable: true }))
      .toEqual({ type: ['string', 'null'], format: 'date-time' });
  });

  it('maps enum, list and obj', () => {
    expect(jsonSchemaForField({ name: 's', type: 'enum', enum: ['a', 'b'] }))
      .toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(jsonSchemaForField({ name: 't', type: 'list', item: { name: 't', type: 'str' } }))
      .toEqual({ type: 'array', items: { type: 'string' } });
    const nested: FieldSpec = {
      name: 'p', type: 'obj',
      fields: [{ name: 'bio', type: 'str', optional: true }],
    };
    expect(jsonSchemaForField(nested)).toEqual({
      type: 'object',
      properties: { bio: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('emits description when present and omits it otherwise', () => {
    expect(jsonSchemaForField({ name: 'x', type: 'str', description: 'hi' }))
      .toEqual({ type: 'string', description: 'hi' });
    expect(jsonSchemaForField({ name: 'x', type: 'str' })).toEqual({ type: 'string' });
  });
});

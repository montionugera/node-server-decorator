import { FieldSpec } from '@montionugera/entity-spec';
import { zodForField } from './index';

// Same value lists as gen_pydantic's test_json_type_parity.py and Go dto's
// TestValidateDateTimeShape — see `type: "datetime"` in
// contracts/rules/entity-spec-validation.md.
describe('datetime — shared RFC 3339 shape', () => {
  const schema = zodForField({ name: 'at', type: 'datetime' } as FieldSpec);

  it.each([
    '2024-01-01 00:00:00Z',
    '2024-01-01t00:00:00z',
    '1704067200',
    '2024-01-01T00:00:00+0100',
    '2024-01-01T00:00:00+01',
    '2024-01-01T00:00:00+24:00',
    '2024-01-01T00:00Z',
    '2024-01-01T00:00:00,5Z',
    '2024-01-01T00:00:00Z\n',
    '2024-02-30T00:00:00Z',
    '2024-01-01T00:00:00',
  ])('rejects %j', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each(['2024-01-01T00:00:00Z', '2024-01-01T00:00:00.123456+07:00', '2024-01-01T23:59:59-23:59'])(
    'accepts %j',
    (value) => {
      expect(schema.safeParse(value).success).toBe(true);
    },
  );
});

describe('str min/max — Unicode code points, not UTF-16 code units', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const schema = zodForField({ name: 'name', type: 'str', min: 2, max: 3 } as FieldSpec);

  it.each([
    ['ab', true],
    ['abcd', false],
    [emoji, false], // 1 code point, 2 UTF-16 units
    [emoji.repeat(3), true], // 3 code points, 6 UTF-16 units
    [emoji.repeat(4), false],
  ])('%j -> %s', (value, ok) => {
    expect(schema.safeParse(value).success).toBe(ok);
  });

  it('still applies format and pattern alongside the length bounds', () => {
    const email = zodForField({ name: 'e', type: 'str', format: 'email', max: 6 } as FieldSpec);
    expect(email.safeParse('a@b.co').success).toBe(true);
    expect(email.safeParse('nope').success).toBe(false);
    expect(email.safeParse('aa@b.co').success).toBe(false);
    const ref = zodForField({ name: 'r', type: 'ref', pattern: '^x', min: 2 } as FieldSpec);
    expect(ref.safeParse('xy').success).toBe(true);
    expect(ref.safeParse('x').success).toBe(false);
    expect(ref.safeParse('yy').success).toBe(false);
  });
});

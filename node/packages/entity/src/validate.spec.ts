import { Restful, action, id, str, int, float, enumOf, listOf, obj } from './index';

// P1 gate-review fixes (C4, C5, C6-escalated-enum, I-a, I-b1). See
// contracts/rules/entity-spec-validation.md for the shared rulings both languages implement.

describe('decoration-time validation', () => {
  it('throws when transports is explicitly empty (C4)', () => {
    expect(() => {
      @Restful({ path: 'x1', transports: [] })
      class X1 {
        @id() id!: string;
      }
      void X1;
    }).toThrow(/transports must not be empty/);
  });

  it('throws when ops is explicitly empty (C4)', () => {
    expect(() => {
      @Restful({ path: 'x2', ops: [] })
      class X2 {
        @id() id!: string;
      }
      void X2;
    }).toThrow(/ops must not be empty/);
  });

  it('throws when enumOf is called with zero values (escalated minor)', () => {
    expect(() => {
      @Restful({ path: 'x3' })
      class X3 {
        @id() id!: string;
        @enumOf([]) status!: string;
      }
      void X3;
    }).toThrow(/enum must have at least one value/);
  });

  it('throws when min is a non-integer (C5)', () => {
    expect(() => {
      @Restful({ path: 'x4' })
      class X4 {
        @id() id!: string;
        @int({ min: 2.5 }) b!: number;
      }
      void X4;
    }).toThrow(/min\/max must be integers/);
  });

  it('throws when max is a non-integer, including whole-number floats (C5)', () => {
    expect(() => {
      @Restful({ path: 'x5' })
      class X5 {
        @id() id!: string;
        @float({ max: 2.5 }) b!: number;
      }
      void X5;
    }).toThrow(/min\/max must be integers/);
  });

  it('throws when both format and pattern are set on one field (I-a)', () => {
    expect(() => {
      @Restful({ path: 'x6' })
      class X6 {
        @id() id!: string;
        @str({ format: 'email', pattern: '^admin@' }) e!: string;
      }
      void X6;
    }).toThrow(/format and pattern are mutually exclusive/);
  });

  it('throws when a wire name collides with a reserved pydantic BaseModel attribute (I-b1)', () => {
    expect(() => {
      @Restful({ path: 'x7' })
      class X7 {
        @id() id!: string;
        @str() copy!: string;
      }
      void X7;
    }).toThrow(/reserved/);
  });

  it('validates nested obj fields recursively', () => {
    expect(() => {
      @Restful({ path: 'x8' })
      class X8 {
        @id() id!: string;
        @obj([{ name: 'schema', type: 'str' }]) profile!: unknown;
      }
      void X8;
    }).toThrow(/reserved/);
  });

  it('validates action input fields', () => {
    expect(() => {
      class X9 {
        @id() id!: string;

        @action('go', { input: [{ name: 'json', type: 'str' }] })
        go(): void {}
      }
      Restful({ path: 'x9' })(X9);
    }).toThrow(/reserved/);
  });

  it('recursively injects the parent field name at every nesting level of a list-of-list (C6)', () => {
    @Restful({ path: 'x10' })
    class X10 {
      @id() id!: string;
      @listOf({ type: 'list', item: { name: '', type: 'str' } }) grid!: string[][];
    }
    const spec = require('./index').entitySpec(X10);
    const gridField = spec.fields.find((f: { name: string }) => f.name === 'grid');
    expect(gridField.item.name).toBe('grid');
    expect(gridField.item.item.name).toBe('grid');
  });

  it('throws when a pattern contains a lookahead (re-review: I-b(2) closure)', () => {
    expect(() => {
      @Restful({ path: 'x12' })
      class X12 {
        @id() id!: string;
        @str({ pattern: '^(?=.*[0-9]).+$' }) e!: string;
      }
      void X12;
    }).toThrow(/not RE2\/rust-regex compatible/);
  });

  it('throws when a pattern contains a negative lookahead', () => {
    expect(() => {
      @Restful({ path: 'x13' })
      class X13 {
        @id() id!: string;
        @str({ pattern: '^(?!admin).+$' }) e!: string;
      }
      void X13;
    }).toThrow(/lookaround/);
  });

  it('throws when a pattern contains lookbehind', () => {
    expect(() => {
      @Restful({ path: 'x14' })
      class X14 {
        @id() id!: string;
        @str({ pattern: '(?<=foo)bar' }) e!: string;
      }
      void X14;
    }).toThrow(/lookaround/);
  });

  it('throws when a pattern contains a backreference', () => {
    expect(() => {
      @Restful({ path: 'x15' })
      class X15 {
        @id() id!: string;
        @str({ pattern: '(a)\\1' }) e!: string;
      }
      void X15;
    }).toThrow(/backreference/);
  });

  it('still accepts a normal, portable pattern', () => {
    @Restful({ path: 'x16' })
    class X16 {
      @id() id!: string;
      @str({ pattern: '^[a-z]+$' }) e!: string;
    }
    const spec = require('./index').entitySpec(X16);
    expect(spec.fields.find((f: { name: string }) => f.name === 'e').pattern).toBe('^[a-z]+$');
  });

  it('does not false-positive on a doubled backslash followed by a digit (escaped literal backslash + literal "1", not a backreference)', () => {
    @Restful({ path: 'x17' })
    class X17 {
      @id() id!: string;
      // Source pattern characters: ^ a \ \ 1 $  — an escaped backslash (\\) followed by a
      // literal "1", NOT a backreference (\1). In a TS string literal, '\\\\1' produces the
      // four characters \ \ 1 in the actual pattern string.
      @str({ pattern: '^a\\\\1$' }) e!: string;
    }
    const spec = require('./index').entitySpec(X17);
    expect(spec.fields.find((f: { name: string }) => f.name === 'e').pattern).toBe('^a\\\\1$');
  });

  it('accepts a valid entity unchanged (control case)', () => {
    @Restful({ path: 'x11' })
    class X11 {
      @id() id!: string;
      @str({ min: 1, max: 10 }) name!: string;
    }
    const spec = require('./index').entitySpec(X11);
    expect(spec.fields.map((f: { name: string }) => f.name)).toEqual(['id', 'name']);
  });
});

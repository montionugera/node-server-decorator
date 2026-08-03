import { Restful, action, entitySpec } from './index';

describe('action()', () => {
  it('does not create an own "to" property when only from is given', () => {
    @Restful({ path: 'a1' })
    class A1 {
      @action('x', { from: 'a' })
      x(): void {}
    }
    const a = entitySpec(A1).actions![0];
    expect(Object.prototype.hasOwnProperty.call(a, 'to')).toBe(false);
    expect(a.from).toBe('a');
  });

  it('does not create an own "from" property when only to is given', () => {
    @Restful({ path: 'a2' })
    class A2 {
      @action('x', { to: 'b' })
      x(): void {}
    }
    const a = entitySpec(A2).actions![0];
    expect(Object.prototype.hasOwnProperty.call(a, 'from')).toBe(false);
    expect(a.to).toBe('b');
  });

  it('creates neither "from" nor "to" when neither is given', () => {
    @Restful({ path: 'a4' })
    class A4 {
      @action('ping')
      ping(): void {}
    }
    const a = entitySpec(A4).actions![0];
    expect(Object.prototype.hasOwnProperty.call(a, 'from')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(a, 'to')).toBe(false);
  });

  it('throws a clear error when applied to a static method', () => {
    expect(() => {
      class A3 {
        @action('x')
        static x(): void {}
      }
      void A3;
    }).toThrow(
      /@action must decorate an instance method \(got static method "x"\)/,
    );
  });
});

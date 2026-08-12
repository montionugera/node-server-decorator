import { Restful, action, entitySpec, id, listOf, obj } from './index';

describe('entitySpec() deep freeze', () => {
  it('freezes the spec, the fields array, each field object, and nested item/fields', () => {
    @Restful({ path: 'things' })
    class Thing {
      @id() id!: string;
      @listOf({ type: 'str' }) tags!: string[];
      @obj([{ name: 'bio', type: 'str' }]) profile!: { bio: string };
    }
    const spec = entitySpec(Thing);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.fields)).toBe(true);
    expect(Object.isFrozen(spec.fields[0])).toBe(true);

    const listField = spec.fields.find((f) => f.name === 'tags')!;
    expect(Object.isFrozen(listField.item)).toBe(true);

    const objField = spec.fields.find((f) => f.name === 'profile')!;
    expect(Object.isFrozen(objField.fields)).toBe(true);
    expect(Object.isFrozen(objField.fields![0])).toBe(true);
  });

  it('freezes the actions array and each action object', () => {
    @Restful({ path: 'things-actions' })
    class ThingWithAction {
      @id() id!: string;
      @action('go', { from: 'a', to: 'b' })
      go(): void {}
    }
    const spec = entitySpec(ThingWithAction);
    expect(Object.isFrozen(spec.actions)).toBe(true);
    expect(Object.isFrozen(spec.actions![0])).toBe(true);
  });

  it('mutation attempts throw in strict mode', () => {
    @Restful({ path: 'things2' })
    class Thing2 {
      @id() id!: string;
    }
    const spec = entitySpec(Thing2);
    expect(() => {
      spec.fields.push({ name: 'evil', type: 'str' });
    }).toThrow(TypeError);
    expect(() => {
      spec.fields[0].name = 'evil';
    }).toThrow(TypeError);
  });

  it('a mutation attempt against one entitySpec() call does not corrupt a subsequent call', () => {
    @Restful({ path: 'things3' })
    class Thing3 {
      @id() id!: string;
    }
    const spec1 = entitySpec(Thing3);
    try {
      spec1.fields.push({ name: 'evil', type: 'str' });
    } catch {
      // expected in strict mode; the assertion below is what actually matters
    }
    const spec2 = entitySpec(Thing3);
    expect(spec2.fields).toHaveLength(1);
    expect(spec2.fields).toBe(spec1.fields);
  });
});

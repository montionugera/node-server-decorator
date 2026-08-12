import { specFor, addField, addAction } from './registry';

describe('registry', () => {
  it('accumulates fields and actions per constructor', () => {
    class A {}
    addField(A, { name: 'x', type: 'str' });
    addAction(A, { name: 'go' });
    expect(specFor(A).fields).toEqual([{ name: 'x', type: 'str' }]);
    expect(specFor(A).actions).toEqual([{ name: 'go' }]);
  });
  it('keeps separate specs for separate classes', () => {
    class B {}
    class C {}
    addField(B, { name: 'b', type: 'int' });
    expect(specFor(C).fields).toEqual([]);
  });
});

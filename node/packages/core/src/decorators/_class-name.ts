const anonymousClassIds = new WeakMap<object, number>();
let anonymousClassCount = 0;
/** Class name used in default breaker/bucket keys; anonymous classes get a unique stable name. */
export function resolveClassName(target: any): string {
  const ctor = typeof target === 'function' ? target : target.constructor;
  if (ctor.name) return ctor.name;
  let id = anonymousClassIds.get(ctor);
  if (id === undefined) {
    id = ++anonymousClassCount;
    anonymousClassIds.set(ctor, id);
  }
  return `<anonymous#${id}>`;
}

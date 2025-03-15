import {globalEmitter} from "./global-emitter";


/**
 * A small type guard to check if a returned value is a Promise.
 */
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    if (typeof value !== 'object' || value === null) return false
    return typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Decorator that emits an event named "ClassName.methodName" whenever
 * the decorated method completes successfully (sync or async).
 */
export function EmitOnSuccess(option?: { transform?: (result: any) => any }) {
    const { transform } = option ?? {};

    return function <T extends (...args: any[]) => any>(
        target: object,
        propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<T>
    ): TypedPropertyDescriptor<T> | void {
        const originalMethod = descriptor.value;
        if (!originalMethod) return descriptor;

        const newMethod = function (this: any, ...args: Parameters<T>): ReturnType<T> {
            const result = originalMethod.apply(this, args);
            const className = this.constructor?.name || target.constructor?.name;
            const eventName = `${className}.${String(propertyKey)}`;

            if (result && typeof result.then === 'function') {
                return (result.then((res: any) => {
                    globalEmitter.emit(eventName, transform ? transform(res) : res);
                    return res;
                }) as unknown) as ReturnType<T>;
            }
            globalEmitter.emit(eventName, transform ? transform(result) : result);
            return result;
        };

        // Cast the new method back to the original type T.
        descriptor.value = newMethod as unknown as T;
        return descriptor;
    };
}

import { globalEmitter } from "./global-emitter";
import { globalQueue, QueueMessage } from "./global-queue";
import { globalLogger } from "../logger";

/**
 * A small type guard to check if a returned value is a Promise.
 */
function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    if (typeof value !== 'object' || value === null) return false
    return typeof (value as { then?: unknown }).then === 'function'
}

export interface EmitOnSuccessOptions {
  transform?: (result: any) => any;
  useQueue?: boolean;
  useEvents?: boolean;
  queueMetadata?: Record<string, any>;
}

/**
 * Enhanced decorator that can emit events and/or publish to queues 
 * when the decorated method completes successfully (sync or async).
 */
export function EmitOnSuccess(options?: EmitOnSuccessOptions) {
    const { 
        transform, 
        useQueue = false, 
        useEvents = true, 
        queueMetadata = {} 
    } = options ?? {};

    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;
        if (!originalMethod) return descriptor;

        const newMethod = function (this: any, ...args: any[]): any {
            const result = originalMethod.apply(this, args);
            const className = this.constructor?.name || target.constructor?.name;
            const eventName = `${className}.${String(propertyKey)}`;

            const handleSuccess = async (res: any) => {
                const processedResult = transform ? transform(res) : res;
                
                // Emit event if enabled (default behavior)
                if (useEvents) {
                    globalEmitter.emit(eventName, processedResult);
                }
                
                // Publish to queue if enabled and queue is available
                if (useQueue && globalQueue) {
                    try {
                        const queueMessage: QueueMessage = {
                            eventName,
                            payload: processedResult,
                            timestamp: Date.now(),
                            metadata: {
                                className,
                                methodName: String(propertyKey),
                                ...queueMetadata
                            }
                        };
                        await globalQueue.publish(queueMessage);
                    } catch (error) {
                        globalLogger.error(`Failed to publish to queue: ${error}`);
                    }
                } else if (useQueue && !globalQueue) {
                    globalLogger.warn(`Queue requested but no globalQueue configured for ${eventName}`);
                }
                
                return res;
            };

            if (result && typeof result.then === 'function') {
                return result.then(handleSuccess);
            }
            
            // Handle sync methods
            handleSuccess(result).catch(error => {
                globalLogger.error(`Error in EmitOnSuccess sync handler: ${error}`);
            });
            
            return result;
        };

        descriptor.value = newMethod;
        return descriptor;
    };
}

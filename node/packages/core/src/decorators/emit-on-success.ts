import { globalEmitter } from './global-emitter';
import { globalQueue, QueueMessage } from './global-queue';
import { globalQueueRegistry } from './queue-registry';
import { globalLogger } from '../logger';
import { getService } from '../config';
import { getActiveTraceContext, formatTraceparent } from './trace';

export interface EmitOnSuccessOptions {
  /**
   * Transform the result before emitting/publishing
   */
  transform?: (result: any) => any;
  
  /**
   * Use event emission (default: true)
   */
  useEvents?: boolean;
  
  /**
   * Use queue publishing (default: false)
   */
  useQueue?: boolean;
  
  /**
   * Specific queue name to use (if not specified, uses default queue)
   */
  queue?: string;
  
  /**
   * Topic for message routing (useful for topic-based systems)
   */
  topic?: string;
  
  /**
   * Additional metadata to include with the message
   */
  queueMetadata?: Record<string, any>;
  
  /**
   * Event name override (default: ClassName.methodName)
   */
  eventName?: string;
}

export function EmitOnSuccess(options: EmitOnSuccessOptions = {}) {
  const {
    transform,
    useEvents = true,
    useQueue = false,
    queue: queueName,
    topic,
    queueMetadata = {},
    eventName: customEventName
  } = options;

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = function (...args: any[]) {
      const result = originalMethod.apply(this, args);
      
      // Handle both sync and async methods
      if (result && typeof result.then === 'function') {
        // Async method
        return result.then(async (res: any) => {
          await handleSuccess(res, target, propertyKey, {
            transform,
            useEvents,
            useQueue,
            queueName,
            topic,
            queueMetadata,
            customEventName
          });
          return res;
        });
      } else {
        // Sync method
        handleSuccess(result, target, propertyKey, {
          transform,
          useEvents,
          useQueue,
          queueName,
          topic,
          queueMetadata,
          customEventName
        }).catch(error => {
          globalLogger.error(`Error in EmitOnSuccess handler: ${error}`);
        });
        return result;
      }
    };
    
    return descriptor;
  };
}

async function handleSuccess(
  result: any, 
  target: any, 
  propertyKey: string, 
  options: {
    transform?: (result: any) => any;
    useEvents: boolean;
    useQueue: boolean;
    queueName?: string;
    topic?: string;
    queueMetadata: Record<string, any>;
    customEventName?: string;
  }
) {
  const { 
    transform, 
    useEvents, 
    useQueue, 
    queueName, 
    topic, 
    queueMetadata,
    customEventName 
  } = options;
  
  const className = target.constructor.name;
  const eventName = customEventName || `${className}.${propertyKey}`;
  const payload = transform ? transform(result) : result;

  // Event emission
  if (useEvents) {
    try {
      globalEmitter.emit(eventName, payload);
      globalLogger.debug(`📡 Event emitted: ${eventName}`);
    } catch (error) {
      globalLogger.error(`Failed to emit event ${eventName}: ${error}`);
    }
  }

  // Queue publishing
  if (useQueue) {
    try {
      const service = getService();
      const activeTrace = getActiveTraceContext();
      const message: QueueMessage = {
        eventName,
        payload,
        timestamp: Date.now(),
        metadata: {
          className,
          methodName: propertyKey,
          topic,
          ...(service ? { service } : {}),
          ...queueMetadata,
          ...(activeTrace
            ? {
                traceparent: formatTraceparent(activeTrace.traceId, activeTrace.spanId, activeTrace.sampled),
                ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {})
              }
            : {})
        }
      };

      // Use QueueRegistry for multi-queue support
      if (queueName || topic || service) {
        // Auto-generate topic from ClassName.methodName if not specified
        const base = `${className}.${propertyKey}`;
        const autoTopic = topic || (service ? `${service}.${base}` : base);
        await globalQueueRegistry.publish(message, queueName, autoTopic);
      } else {
        // Fallback to global queue for backward compatibility
        if (globalQueue) {
          await globalQueue.publish(message);
        } else {
          // Try default queue from registry
          await globalQueueRegistry.publish(message);
        }
      }
      
      globalLogger.debug(`📮 Message queued: ${eventName} -> ${queueName || 'default'}`);
    } catch (error) {
      globalLogger.error(`Failed to publish to queue: ${error}`);
    }
  }
}

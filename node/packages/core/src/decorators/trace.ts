import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
  tracestate?: string;
  activeSpan?: TraceSpan;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, any>;
  status: 'OK' | 'ERROR';
  error?: Error;
  setAttributes(attrs: Record<string, any>): void;
  recordException(error: Error): void;
  end(): void;
}

export interface TraceOptions {
  /**
   * Custom span name. Defaults to `${ClassName}.${MethodName}`.
   */
  name?: string;
  /**
   * Static attributes or dynamic attribute extractor function from invocation arguments.
   */
  attributes?: Record<string, any> | ((...args: any[]) => Record<string, any>);
  /**
   * Whether to record unhandled errors on the span. Default: true.
   */
  recordError?: boolean;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getActiveTraceContext(): TraceContext | null {
  return traceStorage.getStore() ?? null;
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Parses W3C traceparent header: 00-${traceId}-${spanId}-${flags}
 */
export function parseTraceparent(header?: string): {
  version: string;
  traceId: string;
  spanId: string;
  sampled: boolean;
} | null {
  if (!header || typeof header !== 'string') return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;

  // Validate version: must be 00 (reject ff)
  if (version !== '00') return null;

  // Validate traceId: 32 hex chars, not all zeroes
  if (!/^[0-9a-f]{32}$/i.test(traceId) || /^0+$/.test(traceId)) return null;

  // Validate spanId: 16 hex chars, not all zeroes
  if (!/^[0-9a-f]{16}$/i.test(spanId) || /^0+$/.test(spanId)) return null;

  // Validate flags: 2 hex chars
  if (!/^[0-9a-f]{2}$/i.test(flags)) return null;

  const sampled = (parseInt(flags, 16) & 0x01) === 1;

  return {
    version,
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    sampled,
  };
}

/**
 * Formats a valid W3C traceparent string.
 */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  const flags = sampled ? '01' : '00';
  return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${flags}`;
}

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

class SpanImpl implements TraceSpan {
  public traceId: string;
  public spanId: string;
  public parentSpanId?: string;
  public name: string;
  public startTime: number;
  public endTime?: number;
  public durationMs?: number;
  public attributes: Record<string, any> = {};
  public status: 'OK' | 'ERROR' = 'OK';
  public error?: Error;

  constructor(name: string, traceId: string, spanId: string, parentSpanId?: string) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
    this.startTime = Date.now();
  }

  setAttributes(attrs: Record<string, any>): void {
    Object.assign(this.attributes, attrs);
  }

  recordException(error: Error): void {
    this.status = 'ERROR';
    this.error = error;
    this.attributes['exception.type'] = error.name;
    this.attributes['exception.message'] = error.message;
    if (error.stack) {
      this.attributes['exception.stacktrace'] = error.stack;
    }
  }

  end(): void {
    if (!this.endTime) {
      this.endTime = Date.now();
      this.durationMs = this.endTime - this.startTime;
    }
  }
}

/**
 * Hook for testing or integrating with external OpenTelemetry exporters.
 */
export type SpanExporterCallback = (span: TraceSpan) => void;
let globalSpanExporter: SpanExporterCallback | null = null;

export function setSpanExporter(exporter: SpanExporterCallback | null): void {
  globalSpanExporter = exporter;
}

/**
 * Method decorator that creates an active OpenTelemetry trace span and manages W3C context.
 */
export function trace(options: TraceOptions = {}) {
  const recordError = options.recordError ?? true;

  return function (
    target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<any>>
  ) {
    const originalMethod = descriptor.value;
    if (!originalMethod) return descriptor;

    const spanName =
      options.name ??
      `${target?.constructor?.name ?? target?.name ?? 'Anonymous'}.${propertyKey}`;

    descriptor.value = async function (this: any, ...args: any[]) {
      const parentContext = getActiveTraceContext();
      const traceId = parentContext ? parentContext.traceId : generateTraceId();
      const spanId = generateSpanId();
      const parentSpanId = parentContext ? parentContext.spanId : undefined;
      const sampled = parentContext ? parentContext.sampled : true;

      const span = new SpanImpl(spanName, traceId, spanId, parentSpanId);

      // Extract static or dynamic attributes
      if (options.attributes) {
        const dynamicAttrs =
          typeof options.attributes === 'function'
            ? options.attributes(...args)
            : options.attributes;
        span.setAttributes(dynamicAttrs);
      }

      const currentContext: TraceContext = {
        traceId,
        spanId,
        parentSpanId,
        sampled,
        tracestate: parentContext?.tracestate,
        activeSpan: span,
      };

      return traceStorage.run(currentContext, async () => {
        try {
          const result = await originalMethod.apply(this, args);
          return result;
        } catch (err: any) {
          if (recordError && err instanceof Error) {
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
          if (globalSpanExporter) {
            try {
              globalSpanExporter(span);
            } catch {
              // Non-blocking exporter failure
            }
          }
        }
      });
    };

    return descriptor;
  };
}

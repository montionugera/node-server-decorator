import * as fs from 'fs';
import * as path from 'path';
import {
  trace,
  getActiveTraceContext,
  parseTraceparent,
  formatTraceparent,
  setSpanExporter,
  TraceSpan,
} from './trace';
import { EmitOnSuccess } from './emit-on-success';
import { InMemoryQueueAdapter } from './queue-adapters';
import { globalQueueRegistry } from './queue-registry';
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry';

const fixturesPath = path.resolve(__dirname, '../../../../../contracts/fixtures/trace-context.cases.json');
const fixtures: Array<{
  traceparent: string;
  valid: boolean;
  traceId?: string;
  spanId?: string;
  sampled?: boolean;
}> = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

describe('OpenTelemetry Tracing & W3C Propagation', () => {
  let capturedSpans: TraceSpan[] = [];

  beforeEach(() => {
    capturedSpans = [];
    setSpanExporter((span) => {
      capturedSpans.push(span);
    });
    globalQueueRegistry.clear();
  });

  afterEach(() => {
    setSpanExporter(null);
    globalQueueRegistry.clear();
  });

  describe('W3C Carrier Parsing & Formatting', () => {
    it('matches contract fixture test cases', () => {
      for (const tc of fixtures) {
        const parsed = parseTraceparent(tc.traceparent);
        if (tc.valid) {
          expect(parsed).not.toBeNull();
          expect(parsed?.traceId).toBe(tc.traceId);
          expect(parsed?.spanId).toBe(tc.spanId);
          expect(parsed?.sampled).toBe(tc.sampled);
        } else {
          expect(parsed).toBeNull();
        }
      }
    });

    it('formats valid traceparent string', () => {
      const header = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', true);
      expect(header).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    });
  });

  describe('@trace Decorator', () => {
    it('creates active span with generated traceId and spanId', async () => {
      class UserService {
        @trace({ name: 'users.getById', attributes: (id: string) => ({ 'user.id': id }) })
        async getUser(id: string) {
          const ctx = getActiveTraceContext();
          expect(ctx).toBeDefined();
          expect(ctx?.traceId).toMatch(/^[0-9a-f]{32}$/);
          return { id, name: 'Alice' };
        }
      }

      const svc = new UserService();
      const res = await svc.getUser('u-123');
      expect(res).toEqual({ id: 'u-123', name: 'Alice' });

      expect(capturedSpans.length).toBe(1);
      const span = capturedSpans[0];
      expect(span.name).toBe('users.getById');
      expect(span.attributes['user.id']).toBe('u-123');
      expect(span.status).toBe('OK');
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates parent spanId when nested spans execute', async () => {
      class NestedService {
        @trace({ name: 'parent.operation' })
        async parent() {
          return await this.child();
        }

        @trace({ name: 'child.operation' })
        async child() {
          const ctx = getActiveTraceContext();
          return ctx;
        }
      }

      const svc = new NestedService();
      const childCtx = await svc.parent();

      expect(capturedSpans.length).toBe(2);
      const childSpan = capturedSpans.find((s) => s.name === 'child.operation')!;
      const parentSpan = capturedSpans.find((s) => s.name === 'parent.operation')!;

      expect(childSpan).toBeDefined();
      expect(parentSpan).toBeDefined();
      expect(childSpan.traceId).toBe(parentSpan.traceId);
      expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
      expect(childCtx?.parentSpanId).toBe(parentSpan.spanId);
    });

    it('records error status and exception attributes when call fails', async () => {
      class ErrorService {
        @trace({ name: 'failing.operation' })
        async fail() {
          throw new Error('Database connection reset');
        }
      }

      const svc = new ErrorService();
      await expect(svc.fail()).rejects.toThrow('Database connection reset');

      expect(capturedSpans.length).toBe(1);
      const span = capturedSpans[0];
      expect(span.status).toBe('ERROR');
      expect(span.attributes['exception.type']).toBe('Error');
      expect(span.attributes['exception.message']).toBe('Database connection reset');
      expect(span.attributes['exception.stacktrace']).toBeDefined();
    });
  });

  describe('Queue Message Propagation', () => {
    it('injects traceparent into QueueMessage.metadata via EmitOnSuccess', async () => {
      const adapter = new InMemoryQueueAdapter();
      globalQueueRegistry.register('orders', adapter);

      class OrderService {
        @trace({ name: 'orders.create' })
        @EmitOnSuccess({
          queue: 'orders',
          topic: 'order.created',
          useQueue: true,
          useEvents: false,
        })
        async createOrder(id: string) {
          return { id, total: 250 };
        }
      }

      const svc = new OrderService();
      await svc.createOrder('ord-999');

      const messages = adapter.getMessages('order.created');
      expect(messages.length).toBe(1);
      const msg = messages[0];

      expect(msg.metadata).toBeDefined();
      expect(msg.metadata?.traceparent).toBeDefined();

      const parsed = parseTraceparent(msg.metadata?.traceparent);
      expect(parsed).not.toBeNull();
      expect(parsed?.traceId).toBe(capturedSpans[0].traceId);
    });

    it('activates consumer trace context in ConsumerRegistry.dispatchFor', async () => {
      const registry = new ConsumerRegistry();
      let consumedTraceId: string | undefined;
      let consumedParentSpanId: string | undefined;

      const consumerAdapter = new InMemoryConsumer([]);
      registry.register('test-consumer', consumerAdapter);
      registry.on('order.created', async (payload: any, metadata: any) => {
        const ctx = getActiveTraceContext();
        consumedTraceId = ctx?.traceId;
        consumedParentSpanId = ctx?.parentSpanId;
      }, { consumer: 'test-consumer' });

      const incomingTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const dispatch = registry.dispatchFor('test-consumer');

      await dispatch({
        eventName: 'order.created',
        payload: { id: 'ord-1' },
        timestamp: Date.now(),
        metadata: {
          traceparent: incomingTraceparent,
        },
      });

      expect(consumedTraceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(consumedParentSpanId).toBe('00f067aa0ba902b7');
    });
  });
});

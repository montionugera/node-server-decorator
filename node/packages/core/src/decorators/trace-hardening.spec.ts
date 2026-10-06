import { trace, getActiveTraceContext, setSpanExporter, TraceSpan } from './trace';
import { ConsumerRegistry, InMemoryConsumer } from './consumer-registry';

const PRODUCER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PRODUCER_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${PRODUCER_TRACE_ID}-${PRODUCER_SPAN_ID}-01`;

describe('tracing hardening', () => {
  let spans: TraceSpan[] = [];

  beforeEach(() => {
    spans = [];
    setSpanExporter((span) => {
      spans.push(span);
    });
  });

  afterEach(() => {
    setSpanExporter(null);
  });

  describe('attributes extractor', () => {
    it('does not fail the business method when the extractor throws', async () => {
      class Svc {
        @trace({ name: 'svc.get', attributes: (o: any) => ({ id: o.id }) })
        async get(_o?: { id: string }) {
          return 'ok';
        }
      }

      await expect(new Svc().get(undefined)).resolves.toBe('ok');
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('svc.get');
      expect(spans[0].status).toBe('OK');
      expect(spans[0].attributes).toEqual({});
    });
  });

  describe('error status', () => {
    it('marks the span ERROR when a non-Error value is thrown', async () => {
      class Svc {
        @trace({ name: 'svc.boom' })
        async boom(): Promise<void> {
          throw 'plain string';
        }
      }

      await expect(new Svc().boom()).rejects.toBe('plain string');
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe('ERROR');
      expect(spans[0].attributes['exception.type']).toBeUndefined();
    });

    it('leaves the span OK for a non-Error throw when recordError is false', async () => {
      class Svc {
        @trace({ name: 'svc.boom', recordError: false })
        async boom(): Promise<void> {
          throw 'plain string';
        }
      }

      await expect(new Svc().boom()).rejects.toBe('plain string');
      expect(spans[0].status).toBe('OK');
    });
  });

  describe('consumer span', () => {
    class Worker {
      @trace({ name: 'worker.handle' })
      async handle() {
        return getActiveTraceContext();
      }
    }

    function makeDispatch(handler: (payload: any, metadata: any) => Promise<void> | void) {
      const registry = new ConsumerRegistry();
      registry.register('c', new InMemoryConsumer([]));
      registry.on('order.created', handler, { consumer: 'c' });
      return registry.dispatchFor('c');
    }

    const message = {
      eventName: 'order.created',
      payload: { id: 'ord-1' },
      timestamp: 1,
      metadata: { traceparent: TRACEPARENT, tracestate: 'congo=t61rcWkgMzE' },
    };

    it('exports a CONSUMER span so every parentSpanId resolves to a known span', async () => {
      const dispatch = makeDispatch(async () => {
        await new Worker().handle();
      });

      await dispatch(message);

      expect(spans).toHaveLength(2);
      const known = new Set([PRODUCER_SPAN_ID, ...spans.map((s) => s.spanId)]);
      for (const span of spans) {
        expect(span.traceId).toBe(PRODUCER_TRACE_ID);
        expect(known.has(span.parentSpanId as string)).toBe(true);
      }

      const consumerSpan = spans.find((s) => s.attributes['span.kind'] === 'CONSUMER');
      expect(consumerSpan).toBeDefined();
      expect(consumerSpan?.name).toBe('consume order.created');
      expect(consumerSpan?.parentSpanId).toBe(PRODUCER_SPAN_ID);
      expect(consumerSpan?.status).toBe('OK');
      expect(consumerSpan?.endTime).toBeDefined();

      const handlerSpan = spans.find((s) => s.name === 'worker.handle');
      expect(handlerSpan?.parentSpanId).toBe(consumerSpan?.spanId);
    });

    it('propagates tracestate to the handler context', async () => {
      let tracestate: string | undefined;
      const dispatch = makeDispatch(() => {
        tracestate = getActiveTraceContext()?.tracestate;
      });

      await dispatch(message);

      expect(tracestate).toBe('congo=t61rcWkgMzE');
    });

    it('marks the CONSUMER span ERROR and still rejects when the handler fails', async () => {
      const dispatch = makeDispatch(async () => {
        throw new Error('handler failed');
      });

      await expect(dispatch(message)).rejects.toThrow('handler failed');

      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe('ERROR');
      expect(spans[0].attributes['exception.message']).toBe('handler failed');
    });

    it('exports no span and runs the handler untraced when traceparent is invalid', async () => {
      let ctx: unknown = 'unset';
      const dispatch = makeDispatch(() => {
        ctx = getActiveTraceContext();
      });

      await dispatch({ ...message, metadata: { traceparent: 'ff-bad' } });

      expect(ctx).toBeNull();
      expect(spans).toHaveLength(0);
    });
  });
});

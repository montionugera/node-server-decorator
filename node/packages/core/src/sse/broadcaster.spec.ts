import { SSEBroadcaster, formatSSEMessage, SSEEvent } from './broadcaster';

describe('formatSSEMessage', () => {
  it('formats basic data event', () => {
    const event: SSEEvent = { data: { message: 'hello' } };
    const raw = formatSSEMessage(event);
    expect(raw).toBe('data: {"message":"hello"}\n\n');
  });

  it('formats string data', () => {
    const event: SSEEvent = { data: 'simple text' };
    const raw = formatSSEMessage(event);
    expect(raw).toBe('data: simple text\n\n');
  });

  it('formats event with id and custom event name', () => {
    const event: SSEEvent = {
      id: '123',
      event: 'user_connected',
      data: { userId: 42 },
      timestamp: 1670000000,
    };
    const raw = formatSSEMessage(event);
    expect(raw).toBe('id: 123\nevent: user_connected\ndata: {"userId":42}\n\n');
  });
});

describe('SSEBroadcaster', () => {
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    jest.useFakeTimers();
    broadcaster = new SSEBroadcaster({ heartbeatMs: 1000, historyLimit: 5 });
  });

  afterEach(() => {
    broadcaster.close();
    jest.useRealTimers();
  });

  it('subscribes a client and receives broadcasts', () => {
    const writes: string[] = [];
    const client = {
      write: jest.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
    };

    const unsubscribe = broadcaster.subscribe(client);
    expect(broadcaster.clientCount).toBe(1);

    broadcaster.broadcast({ id: '1', data: 'hello' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('id: 1\ndata: hello\n\n');

    unsubscribe();
    expect(broadcaster.clientCount).toBe(0);

    broadcaster.broadcast({ id: '2', data: 'world' });
    expect(writes).toHaveLength(1);
  });

  it('fans out to multiple clients', () => {
    const client1Writes: string[] = [];
    const client2Writes: string[] = [];

    broadcaster.subscribe({
      write: (chunk: string) => {
        client1Writes.push(chunk);
        return true;
      },
    });

    broadcaster.subscribe({
      write: (chunk: string) => {
        client2Writes.push(chunk);
        return true;
      },
    });

    expect(broadcaster.clientCount).toBe(2);

    broadcaster.broadcast({ data: { count: 1 } });
    expect(client1Writes).toEqual(['data: {"count":1}\n\n']);
    expect(client2Writes).toEqual(['data: {"count":1}\n\n']);
  });

  it('replays history matching Last-Event-ID', () => {
    broadcaster.broadcast({ id: 'ev-1', data: 'msg 1' });
    broadcaster.broadcast({ id: 'ev-2', data: 'msg 2' });
    broadcaster.broadcast({ id: 'ev-3', data: 'msg 3' });

    const writes: string[] = [];
    broadcaster.subscribe(
      {
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
      },
      'ev-1'
    );

    expect(writes).toEqual([
      'id: ev-2\ndata: msg 2\n\n',
      'id: ev-3\ndata: msg 3\n\n',
    ]);
  });

  it('drops older events beyond historyLimit', () => {
    for (let i = 1; i <= 7; i++) {
      broadcaster.broadcast({ id: `ev-${i}`, data: `msg ${i}` });
    }

    const writes: string[] = [];
    broadcaster.subscribe(
      {
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
      },
      'ev-3'
    );

    expect(writes).toEqual([
      'id: ev-4\ndata: msg 4\n\n',
      'id: ev-5\ndata: msg 5\n\n',
      'id: ev-6\ndata: msg 6\n\n',
      'id: ev-7\ndata: msg 7\n\n',
    ]);
  });

  it('sends heartbeat ping on interval via handler', () => {
    const headers: Record<string, string> = {};
    const writes: string[] = [];
    let closeListener: (() => void) | undefined;

    const req = {
      headers: {},
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      }),
    };

    const res = {
      setHeader: jest.fn((key: string, val: string) => {
        headers[key] = val;
      }),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      end: jest.fn(),
    };

    const cleanup = broadcaster.handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(broadcaster.clientCount).toBe(1);

    jest.advanceTimersByTime(1000);
    expect(writes).toEqual([': ping\n\n']);

    jest.advanceTimersByTime(1000);
    expect(writes).toEqual([': ping\n\n', ': ping\n\n']);

    // client disconnect
    if (closeListener) {
      closeListener();
    } else {
      cleanup();
    }
    expect(broadcaster.clientCount).toBe(0);

    jest.advanceTimersByTime(1000);
    // No more pings sent after disconnect
    expect(writes).toHaveLength(2);
  });

  it('replays history in handler if last-event-id header is provided', () => {
    broadcaster.broadcast({ id: 'evt-1', data: 'first' });
    broadcaster.broadcast({ id: 'evt-2', data: 'second' });

    const writes: string[] = [];
    const req = {
      headers: { 'last-event-id': 'evt-1' },
      on: jest.fn(),
    };
    const res = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
    };

    broadcaster.handler(req, res);

    expect(writes).toEqual(['id: evt-2\ndata: second\n\n']);
  });
});

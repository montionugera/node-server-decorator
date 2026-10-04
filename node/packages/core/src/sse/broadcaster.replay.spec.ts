import { SSEBroadcaster } from './broadcaster';

// Replay is positional: event IDs are opaque and carry no ordering.
describe('SSEBroadcaster replay with opaque (non-monotonic) IDs', () => {
  const ids = (write: jest.Mock): string[] =>
    write.mock.calls
      .map((c) => /^id: (.*)$/m.exec(String(c[0])))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);

  it('replays the whole history, in order, when Last-Event-ID is not in the buffer', () => {
    const b = new SSEBroadcaster<string>();
    b.broadcast({ id: 'bbb', data: 'one' });
    b.broadcast({ id: 'aaa', data: 'two' });

    const write = jest.fn();
    b.subscribe({ write }, 'unknown-id');
    expect(ids(write)).toEqual(['bbb', 'aaa']);
  });

  it('replays only events after a known Last-Event-ID and still delivers lower-sorting live IDs', () => {
    const b = new SSEBroadcaster<string>();
    b.broadcast({ id: 'f3c1', data: 'one' });
    b.broadcast({ id: 'zz99', data: 'two' });

    const write = jest.fn();
    b.subscribe({ write }, 'f3c1');
    expect(ids(write)).toEqual(['zz99']);

    b.broadcast({ id: '0a11', data: 'three' });
    expect(ids(write)).toEqual(['zz99', '0a11']);
  });

  it('replays nothing when Last-Event-ID is the newest event', () => {
    const b = new SSEBroadcaster<string>();
    b.broadcast({ id: 'a', data: 'one' });
    const write = jest.fn();
    b.subscribe({ write }, 'a');
    expect(write).not.toHaveBeenCalled();
  });
});

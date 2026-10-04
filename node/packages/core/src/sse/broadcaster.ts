export interface SSEEvent<T = any> {
  id?: string;
  event?: string;
  data: T;
  timestamp?: number;
}

export function formatSSEMessage<T>(event: SSEEvent<T>): string {
  let message = '';
  if (event.id !== undefined && event.id !== null) {
    message += `id: ${event.id}\n`;
  }
  if (event.event !== undefined && event.event !== null) {
    message += `event: ${event.event}\n`;
  }
  const dataStr = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  message += `data: ${dataStr}\n\n`;
  return message;
}

export interface SSEBroadcasterOptions {
  heartbeatMs?: number;
  historyLimit?: number;
}

export interface SSEClientResponse {
  setHeader?(name: string, value: string): void;
  writeHead?(statusCode: number, headers?: Record<string, string>): void;
  flushHeaders?(): void;
  write(chunk: any): boolean | void;
  end?(chunk?: any): void;
}

export class SSEBroadcaster<T = any> {
  private clients: Set<SSEClientResponse> = new Set();
  private history: SSEEvent<T>[] = [];
  private heartbeatMs: number;
  private historyLimit: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: SSEBroadcasterOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15000;
    this.historyLimit = options.historyLimit ?? 100;
  }

  public broadcast(event: SSEEvent<T>): void {
    if (event.id !== undefined && event.id !== null) {
      this.history.push(event);
      if (this.history.length > this.historyLimit) {
        this.history.shift();
      }
    }

    const payload = formatSSEMessage(event);
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  public subscribe(client: SSEClientResponse, lastEventId?: string): () => void {
    this.clients.add(client);

    if (lastEventId) {
      // Replay is positional: events after lastEventId's position in the history,
      // or the whole history when it is not (or no longer) in the buffer.
      let startIndex = 0;
      for (let i = 0; i < this.history.length; i++) {
        if (this.history[i].id === lastEventId) {
          startIndex = i + 1;
          break;
        }
      }
      for (let i = startIndex; i < this.history.length; i++) {
        try {
          client.write(formatSSEMessage(this.history[i]));
        } catch {
          this.clients.delete(client);
          break;
        }
      }
    }

    return () => {
      this.clients.delete(client);
    };
  }

  public handler(req: any, res: SSEClientResponse & { setHeader?: any; flushHeaders?: any }): () => void {
    if (res.setHeader) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const lastEventId =
      req.headers?.['last-event-id'] ||
      (req.query && req.query.lastEventId) ||
      (req.url && new URL(req.url, 'http://localhost').searchParams.get('lastEventId')) ||
      undefined;

    const unsubscribe = this.subscribe(res, typeof lastEventId === 'string' ? lastEventId : undefined);

    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(timer);
        unsubscribe();
      }
    }, this.heartbeatMs);

    const cleanup = () => {
      clearInterval(timer);
      unsubscribe();
    };

    if (req.on) {
      req.on('close', cleanup);
    }

    return cleanup;
  }

  public close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try {
        if (typeof client.end === 'function') {
          client.end();
        }
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  public get clientCount(): number {
    return this.clients.size;
  }
}

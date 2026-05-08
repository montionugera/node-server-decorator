// global-queue.ts

export interface QueueMessage {
  eventName: string;
  payload: any;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface QueueAdapter {
  publish(message: QueueMessage): Promise<void>;
  close?(): Promise<void>;
}

export let globalQueue: QueueAdapter | null = null;

export function setGlobalQueue(queue: QueueAdapter | null) {
  globalQueue = queue;
}

export function hasGlobalQueue(): boolean {
  return globalQueue !== null;
}

// Default no-op queue adapter
export class NoOpQueueAdapter implements QueueAdapter {
  async publish(message: QueueMessage): Promise<void> {
    // Do nothing - fallback when no queue is configured
  }
} 
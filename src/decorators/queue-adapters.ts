// queue-adapters.ts

import { QueueAdapter, QueueMessage } from './global-queue';

/**
 * Redis/BullMQ Queue Adapter
 * Usage: npm install bullmq redis
 */
export class BullMQAdapter implements QueueAdapter {
  private queue: any;

  constructor(queue: any) {
    this.queue = queue;
  }

  async publish(message: QueueMessage): Promise<void> {
    await this.queue.add(message.eventName, {
      payload: message.payload,
      timestamp: message.timestamp,
      metadata: message.metadata
    }, {
      removeOnComplete: 10,
      removeOnFail: 50
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * RabbitMQ Queue Adapter
 * Usage: npm install amqplib
 */
export class RabbitMQAdapter implements QueueAdapter {
  private channel: any;
  private queueName: string;

  constructor(channel: any, queueName: string = 'events') {
    this.channel = channel;
    this.queueName = queueName;
  }

  async publish(message: QueueMessage): Promise<void> {
    const messageBuffer = Buffer.from(JSON.stringify(message));
    await this.channel.sendToQueue(this.queueName, messageBuffer, {
      persistent: true
    });
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

/**
 * In-Memory Queue Adapter (for testing)
 */
export class InMemoryQueueAdapter implements QueueAdapter {
  private messages: QueueMessage[] = [];

  async publish(message: QueueMessage): Promise<void> {
    this.messages.push(message);
    console.log(`📮 Queued: ${message.eventName}`, message.payload);
  }

  getMessages(): QueueMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
} 
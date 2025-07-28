// queue-adapters.ts

import { Queue } from 'bullmq';
import * as amqp from 'amqplib';
import { QueueAdapter, QueueMessage } from './global-queue';

/**
 * Redis/BullMQ Queue Adapter with topic support
 */
export class BullMQAdapter implements QueueAdapter {
  constructor(
    private queue: Queue,
    private options?: {
      topicField?: string; // Field to use for topic routing
      defaultPriority?: number;
    }
  ) {}

  async publish(message: QueueMessage): Promise<void> {
    const topic = message.metadata?.topic;
    const priority = message.metadata?.priority || this.options?.defaultPriority;
    
    // Add topic to job data for routing
    const jobData = {
      ...message,
      ...(topic && { [this.options?.topicField || 'topic']: topic })
    };

    const jobOptions: any = {};
    if (priority !== undefined) {
      jobOptions.priority = priority;
    }
    
    // Use topic as job name if available, otherwise use eventName
    const jobName = topic || message.eventName || 'default';
    
    await this.queue.add(jobName, jobData, jobOptions);
  }
}

/**
 * RabbitMQ/AMQP Queue Adapter with topic exchange support
 */
export class RabbitMQAdapter implements QueueAdapter {
  constructor(
    private channel: amqp.Channel,
    private queueName: string,
    private options?: {
      exchange?: string;
      exchangeType?: 'topic' | 'direct' | 'fanout' | 'headers';
      routingKeyPrefix?: string;
      durable?: boolean;
    }
  ) {}

  async publish(message: QueueMessage): Promise<void> {
    const { exchange, exchangeType = 'topic', routingKeyPrefix = '', durable = true } = this.options || {};
    const topic = message.metadata?.topic;
    
    if (exchange) {
      // Use topic exchange for advanced routing
      await this.channel.assertExchange(exchange, exchangeType, { durable });
      
      // Create routing key from topic and event name
      const routingKey = topic 
        ? `${routingKeyPrefix}${topic}.${message.eventName}`
        : `${routingKeyPrefix}${message.eventName}`;
      
      await this.channel.publish(
        exchange, 
        routingKey, 
        Buffer.from(JSON.stringify(message)),
        { persistent: durable }
      );
    } else {
      // Simple queue publishing
      await this.channel.assertQueue(this.queueName, { durable });
      await this.channel.sendToQueue(
        this.queueName, 
        Buffer.from(JSON.stringify(message)),
        { persistent: durable }
      );
    }
  }
}

/**
 * Apache Kafka Queue Adapter with topic support
 */
export class KafkaAdapter implements QueueAdapter {
  constructor(
    private producer: any, // KafkaJS producer
    private options?: {
      defaultTopic?: string;
      partition?: number;
      keyField?: string;
    }
  ) {}

  async publish(message: QueueMessage): Promise<void> {
    const topic = message.metadata?.topic || this.options?.defaultTopic || 'default';
    const key = message.metadata?.[this.options?.keyField || 'key'] || message.eventName;
    
    await this.producer.send({
      topic,
      messages: [{
        key,
        value: JSON.stringify(message),
        partition: this.options?.partition,
        timestamp: Date.now().toString()
      }]
    });
  }
}

/**
 * In-Memory Queue Adapter for testing with topic simulation
 */
export class InMemoryQueueAdapter implements QueueAdapter {
  private messages: Map<string, QueueMessage[]> = new Map();
  
  constructor(private options?: { logMessages?: boolean }) {}

  async publish(message: QueueMessage): Promise<void> {
    const topic = message.metadata?.topic || 'default';
    
    if (!this.messages.has(topic)) {
      this.messages.set(topic, []);
    }
    
    this.messages.get(topic)!.push(message);
    
    if (this.options?.logMessages) {
      console.log(`📮 Queued [${topic}]: ${message.eventName}`, message.payload);
    }
  }

  // Test helpers
  getMessages(topic: string = 'default'): QueueMessage[] {
    return this.messages.get(topic) || [];
  }

  getAllMessages(): Map<string, QueueMessage[]> {
    return new Map(this.messages);
  }

  clear(topic?: string): void {
    if (topic) {
      this.messages.delete(topic);
    } else {
      this.messages.clear();
    }
  }

  getTopics(): string[] {
    return Array.from(this.messages.keys());
  }
} 
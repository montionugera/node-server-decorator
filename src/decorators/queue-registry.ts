import { QueueAdapter, QueueMessage } from './global-queue';
import { globalLogger } from '../logger';

export interface QueueConfig {
  adapter: QueueAdapter;
  topics?: string[];
  defaultTopic?: string;
  priority?: number;
}

export class QueueRegistry {
  private queues: Map<string, QueueConfig> = new Map();
  private defaultQueue?: string;

  /**
   * Register a queue adapter with optional topic routing
   */
  register(name: string, config: QueueConfig | QueueAdapter): void {
    const queueConfig: QueueConfig = this.isQueueAdapter(config) 
      ? { adapter: config } 
      : config;
    
    this.queues.set(name, queueConfig);
    globalLogger.info(`📋 Queue registered: ${name}`);
  }

  /**
   * Set the default queue for fallback
   */
  setDefault(queueName: string): void {
    if (!this.queues.has(queueName)) {
      throw new Error(`Queue '${queueName}' not registered`);
    }
    this.defaultQueue = queueName;
    globalLogger.info(`🎯 Default queue set: ${queueName}`);
  }

  /**
   * Get a queue adapter by name
   */
  get(queueName?: string): QueueAdapter | null {
    // Use specified queue
    if (queueName) {
      const config = this.queues.get(queueName);
      if (!config) {
        globalLogger.warn(`⚠️ Queue '${queueName}' not found`);
        return null;
      }
      return config.adapter;
    }

    // Use default queue
    if (this.defaultQueue) {
      const config = this.queues.get(this.defaultQueue);
      return config?.adapter || null;
    }

    // Use first available queue
    const firstQueue = Array.from(this.queues.values())[0];
    return firstQueue?.adapter || null;
  }

  /**
   * Publish to a specific queue with topic routing
   */
  async publish(message: QueueMessage, queueName?: string, topic?: string): Promise<void> {
    const adapter = this.get(queueName);
    
    if (!adapter) {
      globalLogger.error(`❌ No queue available for: ${queueName || 'default'}`);
      return;
    }

    try {
      // Add topic to message if specified
      const enrichedMessage = topic ? {
        ...message,
        metadata: {
          ...message.metadata,
          topic
        }
      } : message;

      await adapter.publish(enrichedMessage);
      globalLogger.debug(`📮 Published to queue: ${queueName || 'default'}, topic: ${topic || 'default'}`);
    } catch (error) {
      globalLogger.error(`❌ Failed to publish to queue '${queueName}': ${error}`);
    }
  }

  /**
   * Get all registered queue names
   */
  getQueueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Get queue configuration
   */
  getConfig(queueName: string): QueueConfig | undefined {
    return this.queues.get(queueName);
  }

  /**
   * Check if queue supports a topic
   */
  supportsTopic(queueName: string, topic: string): boolean {
    const config = this.queues.get(queueName);
    if (!config || !config.topics) return true; // No restrictions
    return config.topics.includes(topic);
  }

  /**
   * Remove a queue
   */
  unregister(queueName: string): boolean {
    const removed = this.queues.delete(queueName);
    if (removed) {
      globalLogger.info(`🗑️ Queue unregistered: ${queueName}`);
      
      // Reset default if it was the removed queue
      if (this.defaultQueue === queueName) {
        this.defaultQueue = undefined;
      }
    }
    return removed;
  }

  /**
   * Clear all queues
   */
  clear(): void {
    this.queues.clear();
    this.defaultQueue = undefined;
    globalLogger.info('🧹 All queues cleared');
  }

  /**
   * Get queue statistics
   */
  getStats(): { [queueName: string]: QueueConfig & { isDefault: boolean } } {
    const stats: { [queueName: string]: QueueConfig & { isDefault: boolean } } = {};
    
    for (const [name, config] of this.queues.entries()) {
      stats[name] = {
        ...config,
        isDefault: name === this.defaultQueue
      };
    }
    
    return stats;
  }

  private isQueueAdapter(obj: any): obj is QueueAdapter {
    return obj && typeof obj.publish === 'function';
  }
}

// Global registry instance
export const globalQueueRegistry = new QueueRegistry(); 
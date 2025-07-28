import { QueueRegistry } from './queue-registry';
import { InMemoryQueueAdapter } from './queue-adapters';
import { setGlobalLogger } from '../logger';

describe('QueueRegistry', () => {
  let registry: QueueRegistry;
  let mockLogger: any;

  beforeEach(() => {
    registry = new QueueRegistry();
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    setGlobalLogger(mockLogger);
  });

  describe('Queue Registration', () => {
    it('should register a queue with adapter only', () => {
      const adapter = new InMemoryQueueAdapter();
      registry.register('test-queue', adapter);

      expect(registry.getQueueNames()).toContain('test-queue');
      expect(registry.get('test-queue')).toBe(adapter);
      expect(mockLogger.info).toHaveBeenCalledWith('📋 Queue registered: test-queue');
    });

    it('should register a queue with full config', () => {
      const adapter = new InMemoryQueueAdapter();
      const config = {
        adapter,
        topics: ['topic1', 'topic2'],
        defaultTopic: 'topic1',
        priority: 1
      };

      registry.register('advanced-queue', config);

      const retrievedConfig = registry.getConfig('advanced-queue');
      expect(retrievedConfig).toEqual(config);
      expect(retrievedConfig!.topics).toEqual(['topic1', 'topic2']);
    });

    it('should set and use default queue', () => {
      const adapter1 = new InMemoryQueueAdapter();
      const adapter2 = new InMemoryQueueAdapter();
      
      registry.register('queue1', adapter1);
      registry.register('queue2', adapter2);
      registry.setDefault('queue2');

      expect(registry.get()).toBe(adapter2); // Should return default
      expect(mockLogger.info).toHaveBeenCalledWith('🎯 Default queue set: queue2');
    });

    it('should throw error when setting non-existent queue as default', () => {
      expect(() => registry.setDefault('nonexistent')).toThrow(
        "Queue 'nonexistent' not registered"
      );
    });
  });

  describe('Queue Retrieval', () => {
    beforeEach(() => {
      const adapter1 = new InMemoryQueueAdapter();
      const adapter2 = new InMemoryQueueAdapter();
      registry.register('queue1', adapter1);
      registry.register('queue2', adapter2);
    });

    it('should get queue by name', () => {
      const adapter = registry.get('queue1');
      expect(adapter).toBeInstanceOf(InMemoryQueueAdapter);
    });

    it('should return null for non-existent queue', () => {
      const adapter = registry.get('nonexistent');
      expect(adapter).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith("⚠️ Queue 'nonexistent' not found");
    });

    it('should return default queue when no name specified', () => {
      registry.setDefault('queue2');
      const adapter = registry.get();
      expect(adapter).toBe(registry.get('queue2'));
    });

    it('should return first available queue when no default set', () => {
      const adapter = registry.get();
      expect(adapter).toBe(registry.get('queue1')); // First registered
    });

    it('should return null when no queues registered', () => {
      const emptyRegistry = new QueueRegistry();
      expect(emptyRegistry.get()).toBeNull();
    });
  });

  describe('Message Publishing', () => {
    let adapter: InMemoryQueueAdapter;

    beforeEach(() => {
      adapter = new InMemoryQueueAdapter();
      registry.register('test-queue', adapter);
    });

         it('should publish message to specific queue', async () => {
       const message = {
         eventName: 'test.event',
         payload: { test: true },
         timestamp: Date.now(),
         metadata: {}
       };

      await registry.publish(message, 'test-queue');

      const messages = adapter.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });

         it('should publish message with topic', async () => {
       const message = {
         eventName: 'test.event',
         payload: { test: true },
         timestamp: Date.now(),
         metadata: {}
       };

       await registry.publish(message, 'test-queue', 'user-events');

       // Check messages in 'user-events' topic since that's where it gets routed
       const defaultMessages = adapter.getMessages('default');
       const topicMessages = adapter.getMessages('user-events');
       
       // Should be in the user-events topic
       expect(topicMessages).toHaveLength(1);
       expect(topicMessages[0].metadata?.topic).toBe('user-events');
     });

    it('should handle publishing to non-existent queue', async () => {
             const message = {
         eventName: 'test.event',
         payload: { test: true },
         timestamp: Date.now(),
         metadata: {}
       };

       await registry.publish(message, 'nonexistent');

      expect(mockLogger.error).toHaveBeenCalledWith(
        '❌ No queue available for: nonexistent'
      );
    });

    it('should use default queue when no queue specified', async () => {
      registry.setDefault('test-queue');
      
             const message = {
         eventName: 'test.event',
         payload: { test: true },
         timestamp: Date.now(),
         metadata: {}
       };

       await registry.publish(message);

      const messages = adapter.getMessages();
      expect(messages).toHaveLength(1);
    });
  });

  describe('Topic Support', () => {
    beforeEach(() => {
      const adapter = new InMemoryQueueAdapter();
      registry.register('topic-queue', {
        adapter,
        topics: ['allowed1', 'allowed2'],
        defaultTopic: 'allowed1'
      });
      registry.register('open-queue', new InMemoryQueueAdapter());
    });

    it('should check topic support correctly', () => {
      expect(registry.supportsTopic('topic-queue', 'allowed1')).toBe(true);
      expect(registry.supportsTopic('topic-queue', 'allowed2')).toBe(true);
      expect(registry.supportsTopic('topic-queue', 'forbidden')).toBe(false);
      
      // Queue without topic restrictions should support any topic
      expect(registry.supportsTopic('open-queue', 'anything')).toBe(true);
    });
  });

  describe('Queue Management', () => {
    beforeEach(() => {
      registry.register('queue1', new InMemoryQueueAdapter());
      registry.register('queue2', new InMemoryQueueAdapter());
      registry.setDefault('queue1');
    });

    it('should unregister queue', () => {
      const removed = registry.unregister('queue1');
      
      expect(removed).toBe(true);
      expect(registry.getQueueNames()).not.toContain('queue1');
      expect(mockLogger.info).toHaveBeenCalledWith('🗑️ Queue unregistered: queue1');
    });

    it('should reset default when default queue is unregistered', () => {
      registry.unregister('queue1');
      
      // Should now use first available queue (queue2)
      expect(registry.get()).toBe(registry.get('queue2'));
    });

    it('should return false when unregistering non-existent queue', () => {
      const removed = registry.unregister('nonexistent');
      expect(removed).toBe(false);
    });

    it('should clear all queues', () => {
      registry.clear();
      
      expect(registry.getQueueNames()).toEqual([]);
      expect(registry.get()).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith('🧹 All queues cleared');
    });
  });

  describe('Queue Statistics', () => {
    it('should return comprehensive stats', () => {
      const adapter1 = new InMemoryQueueAdapter();
      const adapter2 = new InMemoryQueueAdapter();
      
      registry.register('queue1', {
        adapter: adapter1,
        topics: ['topic1'],
        priority: 1
      });
      registry.register('queue2', adapter2);
      registry.setDefault('queue1');

      const stats = registry.getStats();

      expect(stats).toEqual({
        queue1: {
          adapter: adapter1,
          topics: ['topic1'],
          priority: 1,
          isDefault: true
        },
        queue2: {
          adapter: adapter2,
          isDefault: false
        }
      });
    });

    it('should return empty stats for empty registry', () => {
      const stats = registry.getStats();
      expect(stats).toEqual({});
    });
  });
}); 
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Queue, Worker, Job } from 'bullmq';
import { 
  globalQueueRegistry,
  BullMQAdapter,
  globalLogger,
  globalTracker
} from '../index';

describe('Redis E2E - Simple Tests', () => {
  let redisContainer: StartedTestContainer;
  let redisQueue: Queue;
  let worker: Worker;
  let processedJobs: any[] = [];

  beforeAll(async () => {
    console.log('🐳 Starting Redis container...');
    
    // Start Redis container
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();

    const redisHost = redisContainer.getHost();
    const redisPort = redisContainer.getMappedPort(6379);
    
    console.log(`✅ Redis running on ${redisHost}:${redisPort}`);

    // Setup Redis queue
    redisQueue = new Queue('e2e-simple', {
      connection: { host: redisHost, port: redisPort }
    });

    // Setup worker to process jobs
    worker = new Worker('e2e-simple', async (job: Job) => {
      console.log(`🔄 Processing job: ${job.name}`, job.data);
      processedJobs.push({
        id: job.id,
        name: job.name,
        data: job.data,
        timestamp: Date.now()
      });
      return { processed: true, jobId: job.id };
    }, {
      connection: { host: redisHost, port: redisPort }
    });

    // Clean any existing jobs
    await redisQueue.obliterate({ force: true });
    
  }, 60000);

  afterAll(async () => {
    console.log('🧹 Cleaning up...');
    
    if (worker) {
      await worker.close();
    }
    if (redisQueue) {
      await redisQueue.close();
    }
    if (redisContainer) {
      await redisContainer.stop();
    }
  });

  beforeEach(async () => {
    processedJobs = [];
    
    // Clear queue
    await redisQueue.obliterate({ force: true });
    
    // Clear registry and setup Redis adapter
    globalQueueRegistry.clear();
    globalQueueRegistry.register('redis', {
      adapter: new BullMQAdapter(redisQueue),
      topics: ['orders', 'analytics', 'notifications'],
      defaultTopic: 'orders'
    });
    globalQueueRegistry.setDefault('redis');
  });

  describe('🚀 Queue Registry & BullMQ Integration', () => {
    it('should publish and process messages through Redis queue', async () => {
      const message = {
        eventName: 'TestEvent',
        payload: { orderId: 'ord-123', amount: 99.99 },
        timestamp: Date.now(),
        metadata: { service: 'test-service' }
      };

      // Publish directly to queue registry
      await globalQueueRegistry.publish(message, 'redis', 'orders');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(processedJobs).toHaveLength(1);
      expect(processedJobs[0].data).toMatchObject({
        eventName: 'TestEvent',
        payload: { orderId: 'ord-123', amount: 99.99 },
        metadata: { 
          service: 'test-service',
          topic: 'orders'
        }
      });

      console.log('✅ Direct queue publishing test passed!');
    });

    it('should handle multiple topics correctly', async () => {
      const messages = [
        {
          eventName: 'OrderCreated',
          payload: { orderId: 'ord-001' },
          timestamp: Date.now(),
          metadata: {}
        },
        {
          eventName: 'UserTracked',
          payload: { userId: 'user-001' },
          timestamp: Date.now(),
          metadata: {}
        },
        {
          eventName: 'NotificationSent',
          payload: { notificationId: 'notif-001' },
          timestamp: Date.now(),
          metadata: {}
        }
      ];

      // Publish to different topics
      await globalQueueRegistry.publish(messages[0], 'redis', 'orders');
      await globalQueueRegistry.publish(messages[1], 'redis', 'analytics');
      await globalQueueRegistry.publish(messages[2], 'redis', 'notifications');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(processedJobs).toHaveLength(3);

      // Verify topic routing
      const orderJob = processedJobs.find(job => 
        job.data.metadata.topic === 'orders'
      );
      expect(orderJob?.data.eventName).toBe('OrderCreated');

      const analyticsJob = processedJobs.find(job => 
        job.data.metadata.topic === 'analytics'
      );
      expect(analyticsJob?.data.eventName).toBe('UserTracked');

      const notificationJob = processedJobs.find(job => 
        job.data.metadata.topic === 'notifications'
      );
      expect(notificationJob?.data.eventName).toBe('NotificationSent');

      console.log('✅ Multi-topic routing test passed!');
    });

    it('should handle high-volume message processing', async () => {
      const messageCount = 50;
      const startTime = Date.now();

      // Generate and publish multiple messages
      const publishPromises = Array.from({ length: messageCount }, async (_, i) => {
        const message = {
          eventName: 'HighVolumeTest',
          payload: { 
            messageId: `msg-${i}`,
            data: `test-data-${i}`,
            timestamp: Date.now()
          },
          timestamp: Date.now(),
          metadata: { batch: 'high-volume-test' }
        };
        
        await globalQueueRegistry.publish(message, 'redis', 'analytics');
      });

      await Promise.all(publishPromises);
      const publishTime = Date.now() - startTime;

      // Wait for all messages to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(processedJobs.length).toBeGreaterThanOrEqual(messageCount);
      expect(publishTime).toBeLessThan(5000); // Should publish within 5 seconds

      // Verify all messages have correct metadata
      processedJobs.forEach(job => {
        expect(job.data.metadata.batch).toBe('high-volume-test');
        expect(job.data.metadata.topic).toBe('analytics');
      });

      console.log(`✅ Processed ${processedJobs.length} messages in ${publishTime}ms`);
    });
  });

  describe('🛡️ Error Handling & Resilience', () => {
    it('should handle Redis connection failures gracefully', async () => {
      const message = {
        eventName: 'TestBeforeFailure',
        payload: { test: 'before' },
        timestamp: Date.now(),
        metadata: {}
      };

      // First message should work
      await globalQueueRegistry.publish(message, 'redis');
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(processedJobs).toHaveLength(1);

      // Close Redis connection to simulate failure
      await redisQueue.close();

      // Try to publish when Redis is down
      const failMessage = {
        eventName: 'TestDuringFailure',
        payload: { test: 'during' },
        timestamp: Date.now(),
        metadata: {}
      };

      // Should not throw error but log it
      await expect(globalQueueRegistry.publish(failMessage, 'redis')).resolves.not.toThrow();

      console.log('✅ Redis failure handling test passed!');

      // Reconnect for cleanup
      const redisHost = redisContainer.getHost();
      const redisPort = redisContainer.getMappedPort(6379);
      redisQueue = new Queue('e2e-simple', {
        connection: { host: redisHost, port: redisPort }
      });
    });

    it('should handle invalid queue names gracefully', async () => {
      const message = {
        eventName: 'TestInvalidQueue',
        payload: { test: 'data' },
        timestamp: Date.now(),
        metadata: {}
      };

      // Should not throw error when queue doesn't exist
      await expect(globalQueueRegistry.publish(message, 'nonexistent-queue')).resolves.not.toThrow();
      
      // Should not have processed any jobs
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(processedJobs).toHaveLength(0);

      console.log('✅ Invalid queue handling test passed!');
    });
  });

  describe('⚙️ BullMQ Adapter Features', () => {
    it('should handle job priorities and metadata correctly', async () => {
      const adapter = new BullMQAdapter(redisQueue, {
        topicField: 'category',
        defaultPriority: 5
      });

      const message = {
        eventName: 'PriorityTest',
        payload: { important: true },
        timestamp: Date.now(),
        metadata: { 
          topic: 'urgent-orders',
          priority: 10
        }
      };

      await adapter.publish(message);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(processedJobs).toHaveLength(1);
      expect(processedJobs[0].data.metadata.topic).toBe('urgent-orders');
      expect(processedJobs[0].data.category).toBe('urgent-orders'); // Topic field mapping

      console.log('✅ BullMQ adapter features test passed!');
    });

    it('should process jobs with different names based on topics', async () => {
      const messages = [
        {
          eventName: 'Event1',
          payload: { type: 'A' },
          timestamp: Date.now(),
          metadata: { topic: 'topic-a' }
        },
        {
          eventName: 'Event2', 
          payload: { type: 'B' },
          timestamp: Date.now(),
          metadata: { topic: 'topic-b' }
        },
        {
          eventName: 'Event3',
          payload: { type: 'C' },
          timestamp: Date.now(),
          metadata: {} // No topic
        }
      ];

      const adapter = new BullMQAdapter(redisQueue);

      for (const message of messages) {
        await adapter.publish(message);
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(processedJobs).toHaveLength(3);

      // Check job names are set correctly
      const jobWithTopicA = processedJobs.find(job => job.name === 'topic-a');
      const jobWithTopicB = processedJobs.find(job => job.name === 'topic-b');
      const jobWithoutTopic = processedJobs.find(job => job.name === 'Event3');

      expect(jobWithTopicA).toBeDefined();
      expect(jobWithTopicA.data.payload.type).toBe('A');

      expect(jobWithTopicB).toBeDefined();
      expect(jobWithTopicB.data.payload.type).toBe('B');

      expect(jobWithoutTopic).toBeDefined();
      expect(jobWithoutTopic.data.payload.type).toBe('C');

      console.log('✅ Job naming by topic test passed!');
    });
  });

  describe('📊 Performance Monitoring', () => {
    it('should measure end-to-end latency', async () => {
      const latencies: number[] = [];
      const messageCount = 10;

      for (let i = 0; i < messageCount; i++) {
        const startTime = Date.now();
        
        const message = {
          eventName: 'LatencyTest',
          payload: { 
            messageId: i,
            startTime 
          },
          timestamp: startTime,
          metadata: {}
        };

        await globalQueueRegistry.publish(message, 'redis');
        
        // Wait for this specific message to be processed
        await new Promise(resolve => {
          const checkInterval = setInterval(() => {
            const processed = processedJobs.find(job => 
              job.data.payload.messageId === i
            );
            
            if (processed) {
              const latency = processed.timestamp - startTime;
              latencies.push(latency);
              clearInterval(checkInterval);
              resolve(undefined);
            }
          }, 10);
        });
      }

      // Calculate statistics
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const minLatency = Math.min(...latencies);

      expect(latencies).toHaveLength(messageCount);
      expect(avgLatency).toBeLessThan(1000); // Should be under 1 second on average
      expect(maxLatency).toBeLessThan(2000); // Max should be under 2 seconds

      console.log(`⏱️ Latency Stats: avg=${avgLatency.toFixed(2)}ms, min=${minLatency}ms, max=${maxLatency}ms`);
      console.log('✅ Performance monitoring test passed!');
    });
  });
}); 
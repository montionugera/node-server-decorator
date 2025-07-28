import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import * as amqp from 'amqplib';
import { 
  globalQueueRegistry,
  RabbitMQAdapter,
  setGlobalLogger,
  setGlobalTracker
} from '../index';

describe('RabbitMQ E2E - Testcontainers', () => {
  let rabbitmqContainer: StartedTestContainer;
  let connection: any;
  let channel: any;
  let mockLogger: any;
  let mockTracker: any;
  let processedMessages: any[] = [];

  beforeAll(async () => {
    console.log('🐰 Starting RabbitMQ container...');
    
    // Start RabbitMQ container
    rabbitmqContainer = await new GenericContainer('rabbitmq:3-management-alpine')
      .withExposedPorts(5672, 15672)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'admin',
        RABBITMQ_DEFAULT_PASS: 'admin123'
      })
      .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
      .start();

    const amqpPort = rabbitmqContainer.getMappedPort(5672);
    const managementPort = rabbitmqContainer.getMappedPort(15672);
    
    console.log(`✅ RabbitMQ running on AMQP:${amqpPort}, Management:${managementPort}`);

    // Setup AMQP connection
    const amqpUrl = `amqp://admin:admin123@localhost:${amqpPort}`;
    connection = await amqp.connect(amqpUrl);
    channel = await connection.createChannel();
    
    console.log('🔗 AMQP connection established');
    
  }, 90000); // 90s timeout for container startup

  afterAll(async () => {
    console.log('🧹 Cleaning up RabbitMQ...');
    
    if (channel) {
      await channel.close();
    }
    if (connection) {
      await connection.close();
    }
    if (rabbitmqContainer) {
      await rabbitmqContainer.stop();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    processedMessages = [];
    
    // Setup mock logger and tracker
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    
    mockTracker = {
      track: jest.fn()
    };
    
    setGlobalLogger(mockLogger);
    setGlobalTracker(mockTracker);
    
    // Clear and setup queues
    globalQueueRegistry.clear();
    
    // Create test queues
    await channel.assertQueue('e2e-orders', { durable: false, autoDelete: true });
    await channel.assertQueue('e2e-analytics', { durable: false, autoDelete: true });
    await channel.assertQueue('e2e-notifications', { durable: false, autoDelete: true });
    
    // Purge queues
    await channel.purgeQueue('e2e-orders');
    await channel.purgeQueue('e2e-analytics');
    await channel.purgeQueue('e2e-notifications');
  });

  describe('🚀 RabbitMQ Adapter & Queue Registry', () => {
    it('should publish and consume messages through RabbitMQ', async () => {
      // Setup RabbitMQ adapter
      const adapter = new RabbitMQAdapter(channel, 'e2e-orders');
      globalQueueRegistry.register('rabbitmq', {
        adapter,
        topics: ['orders', 'payments'],
        defaultTopic: 'orders'
      });

      // Setup consumer
      await channel.consume('e2e-orders', (msg: any) => {
        if (msg) {
          const data = JSON.parse(msg.content.toString());
          processedMessages.push({
            ...data,
            timestamp: Date.now(),
            routingKey: msg.fields.routingKey
          });
          channel.ack(msg);
        }
      });

      const message = {
        eventName: 'OrderCreated',
        payload: { orderId: 'ord-123', customerId: 'cust-456', total: 99.99 },
        timestamp: Date.now(),
        metadata: { service: 'order-service', priority: 'high' }
      };

      // Publish message
      await globalQueueRegistry.publish(message, 'rabbitmq', 'orders');

      // Wait for message processing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(processedMessages).toHaveLength(1);
      expect(processedMessages[0]).toMatchObject({
        eventName: 'OrderCreated',
        payload: { orderId: 'ord-123', total: 99.99 },
        metadata: { 
          service: 'order-service',
          topic: 'orders'
        }
      });

      console.log('✅ RabbitMQ basic messaging test passed!');
    });

    it('should handle multiple queues with topic routing', async () => {
      // Setup multiple adapters
      const ordersAdapter = new RabbitMQAdapter(channel, 'e2e-orders');
      const analyticsAdapter = new RabbitMQAdapter(channel, 'e2e-analytics');
      const notificationsAdapter = new RabbitMQAdapter(channel, 'e2e-notifications');

      globalQueueRegistry.register('orders-queue', {
        adapter: ordersAdapter,
        topics: ['orders', 'payments'],
        defaultTopic: 'orders'
      });

      globalQueueRegistry.register('analytics-queue', {
        adapter: analyticsAdapter,
        topics: ['user-events', 'page-views'],
        defaultTopic: 'user-events'
      });

      globalQueueRegistry.register('notifications-queue', {
        adapter: notificationsAdapter,
        topics: ['email', 'sms', 'push'],
        defaultTopic: 'email'
      });

      // Setup consumers for each queue
      const queueMessages: { [key: string]: any[] } = {
        orders: [],
        analytics: [],
        notifications: []
      };

      await channel.consume('e2e-orders', (msg: any) => {
        if (msg) {
          queueMessages.orders.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      await channel.consume('e2e-analytics', (msg: any) => {
        if (msg) {
          queueMessages.analytics.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      await channel.consume('e2e-notifications', (msg: any) => {
        if (msg) {
          queueMessages.notifications.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      // Send messages to different queues
      await globalQueueRegistry.publish({
        eventName: 'OrderPlaced',
        payload: { orderId: 'ord-001' },
        timestamp: Date.now(),
        metadata: {}
      }, 'orders-queue', 'orders');

      await globalQueueRegistry.publish({
        eventName: 'PageViewed',
        payload: { page: '/products', userId: 'user-123' },
        timestamp: Date.now(),
        metadata: {}
      }, 'analytics-queue', 'page-views');

      await globalQueueRegistry.publish({
        eventName: 'EmailQueued',
        payload: { email: 'user@example.com', subject: 'Welcome!' },
        timestamp: Date.now(),
        metadata: {}
      }, 'notifications-queue', 'email');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 800));

      // Verify messages went to correct queues
      expect(queueMessages.orders).toHaveLength(1);
      expect(queueMessages.orders[0].eventName).toBe('OrderPlaced');

      expect(queueMessages.analytics).toHaveLength(1);
      expect(queueMessages.analytics[0].eventName).toBe('PageViewed');

      expect(queueMessages.notifications).toHaveLength(1);
      expect(queueMessages.notifications[0].eventName).toBe('EmailQueued');

      console.log('✅ Multi-queue routing test passed!');
    });

    it('should handle high-volume concurrent messaging', async () => {
      const adapter = new RabbitMQAdapter(channel, 'e2e-analytics');
      globalQueueRegistry.register('rabbitmq', adapter);

      // Setup consumer
      const receivedMessages: any[] = [];
      await channel.consume('e2e-analytics', (msg: any) => {
        if (msg) {
          receivedMessages.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      const messageCount = 30;
      console.log(`🚀 Publishing ${messageCount} concurrent messages...`);
      
      const startTime = Date.now();

      // Publish messages concurrently
      const publishPromises = Array.from({ length: messageCount }, async (_, i) => {
        const message = {
          eventName: 'HighVolumeTest',
          payload: { 
            messageId: `msg-${i}`,
            batchId: 'batch-001',
            timestamp: Date.now()
          },
          timestamp: Date.now(),
          metadata: { batch: 'high-volume-test' }
        };
        
        await globalQueueRegistry.publish(message, 'rabbitmq');
      });

      await Promise.all(publishPromises);
      const publishTime = Date.now() - startTime;

      // Wait for all messages to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(receivedMessages.length).toBeGreaterThanOrEqual(messageCount);
      expect(publishTime).toBeLessThan(5000); // Should publish within 5 seconds

      // Verify message integrity
      receivedMessages.forEach(msg => {
        expect(msg.metadata.batch).toBe('high-volume-test');
        expect(msg.payload.batchId).toBe('batch-001');
      });

      console.log(`✅ Processed ${receivedMessages.length} messages in ${publishTime}ms`);
    });
  });

  describe('🛡️ Error Handling & Resilience', () => {
    it('should handle connection failures gracefully', async () => {
      const adapter = new RabbitMQAdapter(channel, 'e2e-orders');
      globalQueueRegistry.register('rabbitmq', adapter);

      // First message should work
      await globalQueueRegistry.publish({
        eventName: 'TestBeforeFailure',
        payload: { test: 'before' },
        timestamp: Date.now(),
        metadata: {}
      }, 'rabbitmq');

      // Close connection to simulate failure
      await connection.close();

      // Try to publish when connection is down
      await expect(globalQueueRegistry.publish({
        eventName: 'TestDuringFailure', 
        payload: { test: 'during' },
        timestamp: Date.now(),
        metadata: {}
      }, 'rabbitmq')).resolves.not.toThrow();

      // Check that error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to publish to queue')
      );

      console.log('✅ RabbitMQ connection failure handling passed!');

      // Reconnect for cleanup
      const amqpPort = rabbitmqContainer.getMappedPort(5672);
      const amqpUrl = `amqp://admin:admin123@localhost:${amqpPort}`;
      connection = await amqp.connect(amqpUrl);
      channel = await connection.createChannel();
    });

    it('should handle invalid queue names gracefully', async () => {
      const message = {
        eventName: 'TestInvalidQueue',
        payload: { test: 'data' },
        timestamp: Date.now(),
        metadata: {}
      };

      // Should not throw error when queue doesn't exist
      await expect(globalQueueRegistry.publish(message, 'nonexistent-rabbitmq-queue')).resolves.not.toThrow();
      
      console.log('✅ Invalid queue handling test passed!');
    });
  });

  describe('⚙️ RabbitMQ AMQP Features', () => {
    it('should support message persistence and durability', async () => {
      // Create durable queue
      await channel.assertQueue('e2e-durable', { durable: true });
      
      const adapter = new RabbitMQAdapter(channel, 'e2e-durable', {
        durable: true
      });

      const message = {
        eventName: 'PersistentMessage',
        payload: { important: true, shouldPersist: true },
        timestamp: Date.now(),
        metadata: { durability: 'required' }
      };

      await adapter.publish(message);

      // Check queue info
      const queueInfo = await channel.checkQueue('e2e-durable');
      expect(queueInfo.messageCount).toBeGreaterThan(0);

      console.log('✅ Message persistence test passed!');
      
      // Cleanup
      await channel.deleteQueue('e2e-durable');
    });

    it('should support routing keys and exchanges', async () => {
      // Create topic exchange
      const exchangeName = 'e2e-topic-exchange';
      await channel.assertExchange(exchangeName, 'topic', { durable: false });

      // Create queues bound to different routing patterns
      await channel.assertQueue('e2e-orders-urgent', { durable: false });
      await channel.assertQueue('e2e-orders-normal', { durable: false });
      
      await channel.bindQueue('e2e-orders-urgent', exchangeName, 'orders.urgent.*');
      await channel.bindQueue('e2e-orders-normal', exchangeName, 'orders.normal.*');

      const adapter = new RabbitMQAdapter(channel, '', {
        exchange: exchangeName,
        routingKeyPrefix: 'orders'
      });

      const urgentMessages: any[] = [];
      const normalMessages: any[] = [];

      // Setup consumers
      await channel.consume('e2e-orders-urgent', (msg: any) => {
        if (msg) {
          urgentMessages.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      await channel.consume('e2e-orders-normal', (msg: any) => {
        if (msg) {
          normalMessages.push(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        }
      });

      // Publish with different routing keys
      await adapter.publish({
        eventName: 'UrgentOrder',
        payload: { priority: 'urgent' },
        timestamp: Date.now(),
        metadata: { topic: 'urgent.payment' }
      });

      await adapter.publish({
        eventName: 'NormalOrder',
        payload: { priority: 'normal' },
        timestamp: Date.now(),
        metadata: { topic: 'normal.creation' }
      });

      // Wait for routing
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(urgentMessages).toHaveLength(1);
      expect(urgentMessages[0].eventName).toBe('UrgentOrder');

      expect(normalMessages).toHaveLength(1);
      expect(normalMessages[0].eventName).toBe('NormalOrder');

      console.log('✅ Exchange routing test passed!');

      // Cleanup
      await channel.deleteQueue('e2e-orders-urgent');
      await channel.deleteQueue('e2e-orders-normal');
      await channel.deleteExchange(exchangeName);
    });
  });

  describe('📊 Performance & Monitoring', () => {
    it('should measure end-to-end latency with RabbitMQ', async () => {
      const adapter = new RabbitMQAdapter(channel, 'e2e-orders');
      globalQueueRegistry.register('rabbitmq', adapter);

      const latencies: number[] = [];
      const messageCount = 10;

      // Setup consumer with latency tracking
      await channel.consume('e2e-orders', (msg: any) => {
        if (msg) {
          const data = JSON.parse(msg.content.toString());
          const latency = Date.now() - data.payload.startTime;
          latencies.push(latency);
          channel.ack(msg);
        }
      });

      for (let i = 0; i < messageCount; i++) {
        const startTime = Date.now();
        
        await globalQueueRegistry.publish({
          eventName: 'LatencyTest',
          payload: { 
            messageId: i,
            startTime 
          },
          timestamp: startTime,
          metadata: {}
        }, 'rabbitmq');
      }

      // Wait for all messages to be processed
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Calculate statistics
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const minLatency = Math.min(...latencies);

      expect(latencies).toHaveLength(messageCount);
      expect(avgLatency).toBeLessThan(1000); // Should be under 1 second on average
      expect(maxLatency).toBeLessThan(2000); // Max should be under 2 seconds

      console.log(`⏱️ RabbitMQ Latency Stats: avg=${avgLatency.toFixed(2)}ms, min=${minLatency}ms, max=${maxLatency}ms`);
      console.log('✅ RabbitMQ performance monitoring test passed!');
    });
  });
}); 
import { Queue } from 'bullmq';
import * as amqp from 'amqplib';
import { 
  EmitOnSuccess, 
  globalQueueRegistry, 
  BullMQAdapter, 
  RabbitMQAdapter,
  KafkaAdapter,
  InMemoryQueueAdapter 
} from '../src/index';

// ==========================================
// MULTI-QUEUE SETUP EXAMPLE
// ==========================================

async function setupMultipleQueues() {
  console.log('🚀 Setting up multiple queues...');

  // 1. Analytics Queue (Redis/BullMQ) - for high-volume events
  const analyticsQueue = new Queue('analytics', {
    connection: { host: 'localhost', port: 6379 }
  });
  globalQueueRegistry.register('analytics', {
    adapter: new BullMQAdapter(analyticsQueue, { 
      topicField: 'category',
      defaultPriority: 3 
    }),
    defaultTopic: 'user-events',
    priority: 1
  });

  // 2. Notifications Queue (RabbitMQ) - for reliable delivery
  const rabbitmqConnection = await amqp.connect('amqp://localhost');
  const rabbitmqChannel = await rabbitmqConnection.createChannel();
  globalQueueRegistry.register('notifications', {
    adapter: new RabbitMQAdapter(rabbitmqChannel, 'notifications', {
      exchange: 'notifications.topic',
      exchangeType: 'topic',
      routingKeyPrefix: 'notify.',
      durable: true
    }),
    defaultTopic: 'email',
    priority: 2
  });

  // 3. Orders Queue (Kafka) - for event streaming
  // Note: Requires kafkajs package
  /*
  const kafka = require('kafkajs');
  const client = kafka({ clientId: 'my-app', brokers: ['localhost:9092'] });
  const producer = client.producer();
  await producer.connect();
  
  globalQueueRegistry.register('orders', {
    adapter: new KafkaAdapter(producer, {
      defaultTopic: 'order-events',
      keyField: 'orderId'
    }),
    priority: 3
  });
  */

  // 4. Testing Queue (In-Memory) - for development
  globalQueueRegistry.register('testing', {
    adapter: new InMemoryQueueAdapter({ logMessages: true }),
    priority: 4
  });

  // Set default queue
  globalQueueRegistry.setDefault('analytics');

  console.log('✅ Queue setup complete!');
  console.log('📊 Registered queues:', globalQueueRegistry.getQueueNames());
}

// ==========================================
// SERVICE EXAMPLES WITH DIFFERENT QUEUES
// ==========================================

class AnalyticsService {
  @EmitOnSuccess({ 
    queue: 'analytics', 
    topic: 'user-events',
    useQueue: true,
    useEvents: false,
    queueMetadata: { source: 'web', priority: 'high' }
  })
  async trackUserAction(userId: string, action: string, metadata?: any) {
    console.log(`📊 Tracking: ${userId} performed ${action}`);
    return {
      userId,
      action,
      timestamp: new Date().toISOString(),
      metadata: metadata || {}
    };
  }

  @EmitOnSuccess({ 
    queue: 'analytics', 
    topic: 'page-views',
    useQueue: true,
    queueMetadata: { category: 'navigation' }
  })
  async trackPageView(userId: string, page: string, duration: number) {
    return {
      userId,
      page,
      duration,
      timestamp: new Date().toISOString()
    };
  }
}

class NotificationService {
  @EmitOnSuccess({ 
    queue: 'notifications', 
    topic: 'email',
    useQueue: true,
    useEvents: false,
    queueMetadata: { priority: 'high', retries: 3 }
  })
  async sendWelcomeEmail(userId: string, email: string) {
    console.log(`📧 Sending welcome email to ${email}`);
    return {
      userId,
      email,
      templateId: 'welcome',
      sentAt: new Date().toISOString()
    };
  }

  @EmitOnSuccess({ 
    queue: 'notifications', 
    topic: 'push',
    useQueue: true,
    queueMetadata: { platform: 'mobile', urgent: true }
  })
  async sendPushNotification(userId: string, message: string) {
    console.log(`📱 Sending push notification: ${message}`);
    return {
      userId,
      message,
      platform: 'mobile',
      sentAt: new Date().toISOString()
    };
  }

  @EmitOnSuccess({ 
    queue: 'notifications', 
    topic: 'slack',
    useQueue: true,
    queueMetadata: { channel: 'alerts', urgency: 'medium' }
  })
  async notifySlackChannel(channel: string, message: string) {
    console.log(`💬 Slack notification to #${channel}: ${message}`);
    return {
      channel,
      message,
      timestamp: Date.now()
    };
  }
}

class OrderService {
  @EmitOnSuccess({ 
    queue: 'orders', 
    topic: 'order-created',
    useQueue: true,
    useEvents: true, // Also emit events for real-time updates
    queueMetadata: { source: 'api', version: 'v1' }
  })
  async createOrder(customerId: string, items: any[], total: number) {
    console.log(`🛒 Creating order for customer ${customerId}`);
    const order = {
      id: `ord-${Date.now()}`,
      customerId,
      items,
      total,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // Business logic here...
    await new Promise(resolve => setTimeout(resolve, 100));

    return order;
  }

  @EmitOnSuccess({ 
    queue: 'orders', 
    topic: 'order-updated',
    useQueue: true,
    queueMetadata: { eventType: 'status-change' }
  })
  async updateOrderStatus(orderId: string, newStatus: string) {
    console.log(`📝 Updating order ${orderId} to ${newStatus}`);
    return {
      orderId,
      oldStatus: 'pending',
      newStatus,
      updatedAt: new Date().toISOString()
    };
  }
}

// ==========================================
// MULTI-TOPIC ROUTING EXAMPLE
// ==========================================

class ECommerceService {
  // Route different events to appropriate queues and topics
  
  @EmitOnSuccess({ 
    queue: 'analytics', 
    topic: 'user-events',
    useQueue: true 
  })
  async userRegistered(userData: any) {
    return { event: 'user_registered', ...userData };
  }

  @EmitOnSuccess({ 
    queue: 'notifications', 
    topic: 'email',
    useQueue: true 
  })
  async sendRegistrationEmail(email: string) {
    return { event: 'registration_email_sent', email };
  }

  @EmitOnSuccess({ 
    queue: 'orders', 
    topic: 'order-created',
    useQueue: true 
  })
  async processPayment(paymentData: any) {
    return { event: 'payment_processed', ...paymentData };
  }

  // Fallback to default queue
  @EmitOnSuccess({ 
    useQueue: true, // Will use default queue (analytics)
    topic: 'system-events'
  })
  async systemHealthCheck() {
    return { 
      event: 'health_check', 
      status: 'healthy', 
      timestamp: Date.now() 
    };
  }
}

// ==========================================
// USAGE EXAMPLE
// ==========================================

async function demonstrateMultiQueueUsage() {
  await setupMultipleQueues();

  const analytics = new AnalyticsService();
  const notifications = new NotificationService();
  const orders = new OrderService();
  const ecommerce = new ECommerceService();

  console.log('\n🎯 Demonstrating multi-queue usage...\n');

  // Different events go to different queues
  await analytics.trackUserAction('user123', 'login', { ip: '192.168.1.1' });
  await notifications.sendWelcomeEmail('user123', 'user@example.com');
  await orders.createOrder('user123', [{ id: 'item1', price: 29.99 }], 29.99);

  // Show queue statistics
  console.log('\n📊 Queue Statistics:');
  const stats = globalQueueRegistry.getStats();
  Object.entries(stats).forEach(([name, config]) => {
    console.log(`  ${name}: ${config.isDefault ? '⭐ default' : ''}`);
  });

  console.log('\n✅ Multi-queue demonstration complete!');
}

// Export for use
export {
  setupMultipleQueues,
  AnalyticsService,
  NotificationService,
  OrderService,
  ECommerceService,
  demonstrateMultiQueueUsage
};

// Run demonstration if executed directly
if (require.main === module) {
  demonstrateMultiQueueUsage().catch(console.error);
} 
import { 
  EmitOnSuccess, 
  tracking,
  setGlobalLogger, 
  setGlobalTracker, 
  globalQueueRegistry,
  InMemoryQueueAdapter,
  globalEmitter
} from '../index';

describe('E2E Workflow Tests (No Docker)', () => {
  let mockLogger: any;
  let mockTracker: any;
  let emittedEvents: any[] = [];
  let queueAdapter: InMemoryQueueAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    emittedEvents = [];
    
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
    
    // Setup event listener
    globalEmitter.removeAllListeners();
    globalEmitter.onAny((event: string | string[], data: any) => {
      const eventName = Array.isArray(event) ? event.join('.') : event;
      emittedEvents.push({ eventName, data, timestamp: Date.now() });
    });
    
    // Setup in-memory queue
    queueAdapter = new InMemoryQueueAdapter({ logMessages: true });
    globalQueueRegistry.clear();
    globalQueueRegistry.register('in-memory', {
      adapter: queueAdapter,
      defaultTopic: 'orders'
    });
    globalQueueRegistry.setDefault('in-memory');
  });

  describe('🛒 Complete E-Commerce Order Flow', () => {
    it('should handle full order lifecycle with all decorators', async () => {
      // Real-world e-commerce services
      class OrderService {
        @tracking
        @EmitOnSuccess({ 
          useEvents: true,
          useQueue: true,
          queue: 'in-memory',
          topic: 'orders',
          queueMetadata: { 
            service: 'order-service',
            version: '1.0.0',
            priority: 'high' 
          }
        })
        async createOrder(customerId: string, items: any[], total: number) {
          // Simulate order processing time
          await new Promise(resolve => setTimeout(resolve, 100));
          
          const order = {
            id: `ord-${Date.now()}`,
            customerId,
            items,
            total,
            status: 'created',
            createdAt: new Date().toISOString(),
            metadata: {
              channel: 'web',
              region: 'us-east-1'
            }
          };

          console.log(`📦 Order created: ${order.id} for $${order.total}`);
          return order;
        }

        @tracking
        @EmitOnSuccess({ 
          useEvents: true,
          useQueue: true,
          queue: 'in-memory',
          topic: 'orders',
          queueMetadata: { eventType: 'status-change' }
        })
        async updateOrderStatus(orderId: string, newStatus: string, reason?: string) {
          await new Promise(resolve => setTimeout(resolve, 50));
          
          return {
            orderId,
            previousStatus: 'created',
            newStatus,
            reason,
            updatedAt: new Date().toISOString(),
            updatedBy: 'system'
          };
        }
      }

      class PaymentService {
        @tracking
        @EmitOnSuccess({ 
          useEvents: true,
          useQueue: true,
          queue: 'in-memory',
          topic: 'payments',
          transform: (result) => ({
            // Transform payment result for analytics
            event: 'payment_processed',
            amount: result.amount,
            currency: result.currency,
            paymentMethod: result.method,
            timestamp: Date.now(),
            success: result.status === 'completed'
          })
        })
        async processPayment(orderId: string, amount: number, method: string = 'credit_card') {
          await new Promise(resolve => setTimeout(resolve, 200)); // Simulate payment processing
          
          const payment = {
            id: `pay-${Date.now()}`,
            orderId,
            amount,
            currency: 'USD',
            method,
            status: 'completed',
            transactionId: `txn-${Math.random().toString(36).substr(2, 9)}`,
            processedAt: new Date().toISOString()
          };

          console.log(`💳 Payment processed: ${payment.id} for $${payment.amount}`);
          return payment;
        }
      }

      class AnalyticsService {
        @tracking
        @EmitOnSuccess({ 
          useEvents: false, // Only queue, no events
          useQueue: true,
          queue: 'in-memory',
          topic: 'analytics',
          queueMetadata: { 
            category: 'user-behavior',
            importance: 'medium' 
          }
        })
        async trackUserAction(userId: string, action: string, context: any) {
          await new Promise(resolve => setTimeout(resolve, 30));
          
          return {
            userId,
            action,
            context,
            sessionId: `sess-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            userAgent: 'test-agent',
            ipAddress: '192.168.1.1'
          };
        }
      }

      class NotificationService {
        @tracking
        @EmitOnSuccess({ 
          useEvents: true,
          useQueue: true,
          queue: 'in-memory',
          topic: 'notifications',
          queueMetadata: { 
            channel: 'email',
            priority: 'high' 
          }
        })
        async sendOrderConfirmation(email: string, orderId: string, orderTotal: number) {
          await new Promise(resolve => setTimeout(resolve, 80));
          
          return {
            notificationId: `notif-${Date.now()}`,
            email,
            orderId,
            type: 'order_confirmation',
            content: `Your order ${orderId} for $${orderTotal} has been confirmed.`,
            sentAt: new Date().toISOString(),
            status: 'sent'
          };
        }
      }

      // Initialize services
      const orderService = new OrderService();
      const paymentService = new PaymentService();
      const analyticsService = new AnalyticsService();
      const notificationService = new NotificationService();

      console.log('\n🚀 Starting complete e-commerce workflow...\n');

      // Step 1: Customer creates order
      const order = await orderService.createOrder('customer-123', [
        { id: 'product-1', name: 'Laptop', price: 999.99, quantity: 1 },
        { id: 'product-2', name: 'Mouse', price: 29.99, quantity: 2 }
      ], 1059.97);

      expect(order).toMatchObject({
        customerId: 'customer-123',
        total: 1059.97,
        status: 'created'
      });

      // Step 2: Track user action
      const userTracking = await analyticsService.trackUserAction(
        'customer-123', 
        'order_created', 
        { orderId: order.id, channel: 'web', source: 'homepage' }
      );

      expect(userTracking.action).toBe('order_created');

      // Step 3: Process payment
      const payment = await paymentService.processPayment(order.id, order.total, 'credit_card');
      
      expect(payment).toMatchObject({
        orderId: order.id,
        amount: 1059.97,
        status: 'completed'
      });

      // Step 4: Update order status after payment
      const statusUpdate = await orderService.updateOrderStatus(order.id, 'paid', 'Payment confirmed');
      
      expect(statusUpdate).toMatchObject({
        orderId: order.id,
        newStatus: 'paid',
        reason: 'Payment confirmed'
      });

      // Step 5: Send confirmation email
      const notification = await notificationService.sendOrderConfirmation(
        'customer123@example.com',
        order.id,
        order.total
      );

      expect(notification.status).toBe('sent');

      console.log('\n✅ E-commerce workflow completed successfully!\n');

      // Verify all tracking calls
      expect(mockTracker.track).toHaveBeenCalledTimes(5);
      
      const trackingCalls = mockTracker.track.mock.calls;
      expect(trackingCalls[0][0]).toBe('OrderService.createOrder');
      expect(trackingCalls[1][0]).toBe('AnalyticsService.trackUserAction');
      expect(trackingCalls[2][0]).toBe('PaymentService.processPayment');
      expect(trackingCalls[3][0]).toBe('OrderService.updateOrderStatus');
      expect(trackingCalls[4][0]).toBe('NotificationService.sendOrderConfirmation');

      // Verify events were emitted (where enabled)
      expect(emittedEvents).toHaveLength(4); // Analytics service doesn't emit events
      
      const orderCreatedEvent = emittedEvents.find(e => e.eventName.includes('OrderService.createOrder'));
      expect(orderCreatedEvent).toBeDefined();

      const paymentEvent = emittedEvents.find(e => e.eventName.includes('PaymentService.processPayment'));
      expect(paymentEvent).toBeDefined();

      // Verify queue messages
      const allMessages = queueAdapter.getAllMessages();
      expect(allMessages.size).toBe(4); // orders, payments, analytics, notifications

      // Check orders topic
      const orderMessages = queueAdapter.getMessages('orders');
      expect(orderMessages).toHaveLength(2); // createOrder + updateOrderStatus

      // Check payments topic with transformed data
      const paymentMessages = queueAdapter.getMessages('payments');
      expect(paymentMessages).toHaveLength(1);
      expect(paymentMessages[0].payload).toMatchObject({
        event: 'payment_processed',
        amount: 1059.97,
        success: true
      });

      // Check analytics topic
      const analyticsMessages = queueAdapter.getMessages('analytics');
      expect(analyticsMessages).toHaveLength(1);
      expect(analyticsMessages[0].metadata?.category).toBe('user-behavior');

      // Check notifications topic
      const notificationMessages = queueAdapter.getMessages('notifications');
      expect(notificationMessages).toHaveLength(1);
      expect(notificationMessages[0].metadata?.channel).toBe('email');

      console.log('📊 All verifications passed!');
    }, 30000);
  });

  describe('🔄 Error Handling & Recovery', () => {
    it('should handle service errors gracefully in workflow', async () => {
      class UnreliableService {
        @tracking
        @EmitOnSuccess({ 
          useEvents: true,
          useQueue: true,
          queue: 'in-memory'
        })
        async reliableMethod(data: any) {
          await new Promise(resolve => setTimeout(resolve, 50));
          return { ...data, processed: true };
        }

        @tracking
        async unreliableMethod(shouldFail: boolean) {
          await new Promise(resolve => setTimeout(resolve, 30));
          
          if (shouldFail) {
            throw new Error('Service temporarily unavailable');
          }
          
          return { success: true };
        }
      }

      const service = new UnreliableService();

      // Test successful operations
      const result1 = await service.reliableMethod({ test: 'data' });
      expect(result1.processed).toBe(true);

      const result2 = await service.unreliableMethod(false);
      expect(result2.success).toBe(true);

      // Test error handling
      await expect(service.unreliableMethod(true))
        .rejects.toThrow('Service temporarily unavailable');

      // Verify tracking recorded both success and error
      expect(mockTracker.track).toHaveBeenCalledTimes(3);
      
      // Check error was tracked
      const errorCall = mockTracker.track.mock.calls.find((call: any) => call[2] === true);
      expect(errorCall).toBeDefined();
      expect(errorCall[0]).toBe('UnreliableService.unreliableMethod');

      // Only successful operations should be queued (check auto-generated topic)
      const messages = queueAdapter.getMessages('UnreliableService.reliableMethod');
      expect(messages).toHaveLength(1);
      expect(messages[0].payload.processed).toBe(true);
    });
  });

  describe('⚡ Performance & Concurrency', () => {
    it('should handle concurrent operations efficiently', async () => {
      class ConcurrentService {
        @tracking
        @EmitOnSuccess({ 
          useQueue: true,
          queue: 'in-memory',
          topic: 'analytics'
        })
        async processTask(taskId: string, delay: number = 50) {
          await new Promise(resolve => setTimeout(resolve, delay));
          
          return {
            taskId,
            processedAt: Date.now(),
            delay,
            worker: 'concurrent-service'
          };
        }
      }

      const service = new ConcurrentService();
      const taskCount = 20;

      console.log(`🚀 Processing ${taskCount} concurrent tasks...`);
      
      const startTime = Date.now();
      
      // Process tasks concurrently
      const tasks = await Promise.all(
        Array.from({ length: taskCount }, (_, i) => 
          service.processTask(`task-${i}`, Math.random() * 100)
        )
      );

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(tasks).toHaveLength(taskCount);
      expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds

      // Verify all tasks were tracked
      expect(mockTracker.track).toHaveBeenCalledTimes(taskCount);

      // Verify all tasks were queued
      const analyticsMessages = queueAdapter.getMessages('analytics');
      expect(analyticsMessages).toHaveLength(taskCount);

      console.log(`✅ Processed ${taskCount} tasks in ${totalTime}ms`);
    });
  });

  describe('🎛️ Configuration & Flexibility', () => {
    it('should support different queue configurations', async () => {
      // Setup multiple queue adapters
      const highPriorityAdapter = new InMemoryQueueAdapter({ logMessages: true });
      const lowPriorityAdapter = new InMemoryQueueAdapter({ logMessages: true });

      globalQueueRegistry.register('high-priority', {
        adapter: highPriorityAdapter,
        priority: 1
      });

      globalQueueRegistry.register('low-priority', {
        adapter: lowPriorityAdapter,
        priority: 2
      });

      class ConfigurableService {
        @EmitOnSuccess({ 
          queue: 'high-priority',
          topic: 'urgent',
          useQueue: true,
          queueMetadata: { priority: 'critical' }
        })
        async urgentTask(data: any) {
          return { ...data, priority: 'urgent' };
        }

        @EmitOnSuccess({ 
          queue: 'low-priority',
          topic: 'batch',
          useQueue: true,
          queueMetadata: { priority: 'low' }
        })
        async batchTask(data: any) {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { ...data, priority: 'batch' };
        }
      }

      const service = new ConfigurableService();

      await service.urgentTask({ task: 'urgent-work' });
      await service.batchTask({ task: 'batch-work' });

      // Verify messages went to correct queues
      const urgentMessages = highPriorityAdapter.getMessages('urgent');
      const batchMessages = lowPriorityAdapter.getMessages('batch');

      expect(urgentMessages).toHaveLength(1);
      expect(urgentMessages[0].payload.priority).toBe('urgent');

      expect(batchMessages).toHaveLength(1);
      expect(batchMessages[0].payload.priority).toBe('batch');

      console.log('✅ Queue configuration test passed!');
    });
  });
}); 
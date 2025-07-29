import { 
  cache, 
  tracking, 
  emitOnSuccess, 
  globalQueueRegistry, 
  InMemoryQueueAdapter,
  globalEmitter 
} from './src/index';

// ==========================================
// 🧪 DECORATOR TESTING DEMO
// ==========================================

// Setup in-memory queue for testing
const memoryAdapter = new InMemoryQueueAdapter();
globalQueueRegistry.register('demo-queue', {
  adapter: memoryAdapter,
  topics: ['orders', 'analytics', 'notifications'],
  defaultTopic: 'orders'
});

// Listen to all events
const events: any[] = [];
globalEmitter.onAny((eventName: string | string[], data: any) => {
  events.push({ 
    event: Array.isArray(eventName) ? eventName.join('.') : eventName, 
    data, 
    timestamp: new Date().toISOString() 
  });
});

class DemoService {
  
  // 🎯 Test 1: Basic tracking + caching
  @tracking()
  @cache(5000) // 5 second cache
  async fetchUserData(userId: string): Promise<any> {
    console.log(`🔍 Fetching user data for: ${userId}`);
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      id: userId,
      name: `User ${userId}`,
      email: `user${userId}@demo.com`,
      fetchedAt: new Date().toISOString()
    };
  }

  // 🎯 Test 2: Queue emission + tracking
  @emitOnSuccess('demo-queue', 'orders', {
    queueMetadata: {
      service: 'demo-service',
      priority: 10
    }
  })
  @tracking()
  async createOrder(customerId: string, items: any[], total: number): Promise<any> {
    console.log(`📦 Creating order for customer: ${customerId}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const order = {
      id: `order-${Date.now()}`,
      customerId,
      items,
      total,
      status: 'created',
      createdAt: new Date().toISOString()
    };
    
    return order;
  }

  // 🎯 Test 3: Multiple decorators with error handling
  @emitOnSuccess('demo-queue', 'notifications', {
    queueMetadata: {
      channel: 'email',
      priority: 5
    }
  })
  @tracking()
  @cache(3000)
  async sendWelcomeEmail(userId: string, shouldFail: boolean = false): Promise<any> {
    console.log(`📧 Sending welcome email to: ${userId}`);
    
    if (shouldFail) {
      throw new Error('Email service temporarily unavailable');
    }
    
    await new Promise(resolve => setTimeout(resolve, 75));
    
    return {
      messageId: `msg-${Date.now()}`,
      userId,
      type: 'welcome',
      sentAt: new Date().toISOString()
    };
  }
}

// ==========================================
// 🧪 RUN TESTS
// ==========================================

async function runDemo() {
  console.log('🚀 Starting Decorator Demo...\n');
  
  const service = new DemoService();
  
  try {
    // Test 1: Caching behavior
    console.log('📊 Test 1: Caching & Tracking');
    console.log('='.repeat(40));
    
    const start1 = Date.now();
    const user1 = await service.fetchUserData('123');
    const time1 = Date.now() - start1;
    console.log(`✅ First call: ${time1}ms`, user1);
    
    const start2 = Date.now();
    const user2 = await service.fetchUserData('123'); // Should be cached
    const time2 = Date.now() - start2;
    console.log(`🚀 Cached call: ${time2}ms`, user2);
    
    console.log(`📈 Performance improvement: ${((time1 - time2) / time1 * 100).toFixed(1)}%\n`);
    
    // Test 2: Queue emission
    console.log('📦 Test 2: Order Creation with Queue');
    console.log('='.repeat(40));
    
    const order = await service.createOrder('cust-456', [
      { id: 'item-1', name: 'Widget', price: 29.99 },
      { id: 'item-2', name: 'Gadget', price: 49.99 }
    ], 79.98);
    
    console.log('✅ Order created:', order);
    console.log('📋 Queue messages:', memoryAdapter.getMessages('orders'));
    
    // Test 3: Error handling
    console.log('\n🛡️ Test 3: Error Handling');
    console.log('='.repeat(40));
    
    try {
      await service.sendWelcomeEmail('user-789', true);
    } catch (error) {
      console.log('❌ Expected error caught:', error.message);
    }
    
    // Test 4: Success case
    const emailResult = await service.sendWelcomeEmail('user-789', false);
    console.log('✅ Email sent:', emailResult);
    
    // Show all events
    console.log('\n📡 All Emitted Events:');
    console.log('='.repeat(40));
    events.forEach((event, index) => {
      console.log(`${index + 1}. ${event.event}:`, event.data);
    });
    
    // Show queue status
    console.log('\n📊 Final Queue Status:');
    console.log('='.repeat(40));
    console.log('Orders:', memoryAdapter.getMessages('orders').length);
    console.log('Notifications:', memoryAdapter.getMessages('notifications').length);
    
  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
}

// Run the demo
runDemo().then(() => {
  console.log('\n🎉 Demo completed successfully!');
}).catch(console.error); 
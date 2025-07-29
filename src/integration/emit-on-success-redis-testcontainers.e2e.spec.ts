import {GenericContainer, StartedTestContainer, Wait} from 'testcontainers';
import {Queue, Worker, Job} from 'bullmq';
import {
    EmitOnSuccess,
    tracking,
    setGlobalLogger,
    setGlobalTracker,
    globalQueueRegistry,
    BullMQAdapter
} from '../index';

describe('Redis E2E Tests', () => {
    let redisContainer: StartedTestContainer;
    let redisQueue: Queue;
    let worker: Worker;
    let mockLogger: any;
    let mockTracker: any;
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
        redisQueue = new Queue('e2e-events', {
            connection: {host: redisHost, port: redisPort}
        });

        // Setup worker to process jobs (process all job types/topics)
        worker = new Worker('e2e-events', async (job: Job) => {
            console.log(`🔄 Processing job: ${job.name}`, job.data);
            processedJobs.push({
                id: job.id,
                name: job.name,
                data: job.data,
                timestamp: Date.now()
            });
            return {processed: true, jobId: job.id};
        }, {
            connection: {host: redisHost, port: redisPort},
            concurrency: 10,
            autorun: true
        });

        // Clean any existing jobs
        await redisQueue.obliterate({force: true});

    }, 60000); // 60s timeout for container startup

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
        jest.clearAllMocks();
        processedJobs = [];

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

        // Clear queue
        await redisQueue.obliterate({force: true});

        // Clear registry and setup Redis adapter
        globalQueueRegistry.clear();
        globalQueueRegistry.register('redis', {
            adapter: new BullMQAdapter(redisQueue),
            topics: ['orders', 'analytics', 'notifications'],
            defaultTopic: 'orders'
        });
        globalQueueRegistry.setDefault('redis');
    });

    describe('🛒 E-Commerce Order Flow', () => {
        it('should handle complete order lifecycle with Redis queue', async () => {
            // Simple service classes to avoid TypeScript decorator stacking issues
            class OrderService {
                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'orders',
                    useQueue: true,
                    useEvents: false,
                    queueMetadata: {
                        service: 'order-service',
                        version: '1.0.0',
                        priority: 10
                    }
                })
                async createOrder(customerId: string, items: any[], total: number) {
                    // Simulate order creation logic
                    await new Promise(resolve => setTimeout(resolve, 50));

                    const order = {
                        id: `ord-${Date.now()}`,
                        customerId,
                        items,
                        total,
                        status: 'pending',
                        createdAt: new Date().toISOString()
                    };

                    console.log(`📦 Order created: ${order.id}`);
                    return order;
                }
            }

            class PaymentService {
                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'analytics',
                    useQueue: true,
                    transform: (result) => ({
                        event: 'payment_processed',
                        amount: result.amount,
                        currency: result.currency,
                        timestamp: Date.now()
                    })
                })
                async processPayment(orderId: string, amount: number, currency: string = 'USD') {
                    await new Promise(resolve => setTimeout(resolve, 40));

                    return {
                        orderId,
                        amount,
                        currency,
                        paymentId: `pay-${Date.now()}`,
                        status: 'completed'
                    };
                }
            }

            class TrackingService {
                @tracking
                async trackAction(action: string, data: any) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return {action, data, tracked: true};
                }
            }

            const orderService = new OrderService();
            const paymentService = new PaymentService();
            const trackingService = new TrackingService();

            // Step 1: Create order
            const order = await orderService.createOrder('cust-123', [
                {id: 'item-1', name: 'Widget', price: 29.99, qty: 2},
                {id: 'item-2', name: 'Gadget', price: 49.99, qty: 1}
            ], 109.97);

            expect(order).toMatchObject({
                customerId: 'cust-123',
                total: 109.97,
                status: 'pending'
            });

            // Step 2: Process payment
            const payment = await paymentService.processPayment(order.id, order.total);

            expect(payment).toMatchObject({
                orderId: order.id,
                amount: 109.97,
                status: 'completed'
            });

            // Step 3: Track the action
            const trackingData = await trackingService.trackAction('order_completed', {
                orderId: order.id,
                amount: order.total
            });

            expect(trackingData.tracked).toBe(true);

            // Wait for all jobs to be processed
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify events were queued and processed
            expect(processedJobs).toHaveLength(2); // Order creation + Payment

            // Check order creation job
            const orderJob = processedJobs.find(job =>
                job.data.eventName === 'OrderService.createOrder'
            );
            expect(orderJob).toBeDefined();
            expect(orderJob.data.payload).toMatchObject({
                customerId: 'cust-123',
                total: 109.97,
                status: 'pending'
            });
            expect(orderJob.data.metadata.topic).toBe('orders');
            expect(orderJob.data.metadata.service).toBe('order-service');

            // Check payment job (with transform)
            const paymentJob = processedJobs.find(job =>
                job.data.eventName === 'PaymentService.processPayment'
            );
            expect(paymentJob).toBeDefined();
            expect(paymentJob.data.payload).toMatchObject({
                event: 'payment_processed',
                amount: 109.97,
                currency: 'USD'
            });
            expect(paymentJob.data.metadata.topic).toBe('analytics');

            // Verify tracking was called
            expect(mockTracker.track).toHaveBeenCalledWith(
                'TrackingService.trackAction',
                expect.any(Number),
                false
            );

            console.log('✅ Complete order flow test passed!');
        }, 30000);

        it('should handle high-volume concurrent orders', async () => {
            class HighVolumeService {
                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'analytics',
                    useQueue: true
                })
                async trackOrder(orderId: string, customerId: string) {
                    return {
                        orderId,
                        customerId,
                        event: 'order_tracked',
                        timestamp: Date.now()
                    };
                }
            }

            const service = new HighVolumeService();
            const orderCount = 25;

            console.log(`🚀 Processing ${orderCount} concurrent orders...`);

            const startTime = Date.now();

            // Process multiple orders concurrently
            const orders = await Promise.all(
                Array.from({length: orderCount}, (_, i) =>
                    service.trackOrder(`ord-${i}`, `cust-${i % 5}`) // 5 different customers
                )
            );

            const endTime = Date.now();
            const duration = endTime - startTime;

            expect(orders).toHaveLength(orderCount);
            expect(duration).toBeLessThan(5000); // Should complete within 5 seconds

            // Wait for all jobs to be processed
            await new Promise(resolve => setTimeout(resolve, 1000));

            expect(processedJobs.length).toBeGreaterThanOrEqual(orderCount);

            console.log(`✅ Processed ${orderCount} orders in ${duration}ms`);
        }, 30000);
    });

    describe('🔄 Error Handling & Recovery', () => {
        it('should handle method errors gracefully while still tracking', async () => {
            class ErrorProneService {
                @tracking
                async riskyOperation(shouldFail: boolean) {
                    await new Promise(resolve => setTimeout(resolve, 20));

                    if (shouldFail) {
                        throw new Error('Simulated failure');
                    }

                    return {success: true, timestamp: Date.now()};
                }

                @EmitOnSuccess({
                    queue: 'redis',
                    useQueue: true
                })
                async queuedOperation(data: any) {
                    return {...data, processed: true};
                }
            }

            const service = new ErrorProneService();

            // Success case with queue
            const successResult = await service.queuedOperation({test: 'data'});
            expect(successResult.processed).toBe(true);

            // Success case with tracking
            const trackResult = await service.riskyOperation(false);
            expect(trackResult.success).toBe(true);

            // Error case with tracking
            await expect(service.riskyOperation(true))
                .rejects.toThrow('Simulated failure');

            // Wait for processing
            await new Promise(resolve => setTimeout(resolve, 200));

            // Verify tracking was called for both success and error
            expect(mockTracker.track).toHaveBeenCalledTimes(2);

            // Should have one queued job from successful operation
            expect(processedJobs).toHaveLength(1);
            expect(processedJobs[0].data.payload.processed).toBe(true);
        });

        it('should continue working when Redis is temporarily unavailable', async () => {
            class ResilientService {
                @EmitOnSuccess({
                    queue: 'redis',
                    useQueue: true
                })
                async doWork(id: string) {
                    return {id, completed: true, timestamp: Date.now()};
                }
            }

            const service = new ResilientService();

            // First, ensure normal operation works
            const result1 = await service.doWork('work-1');
            expect(result1.completed).toBe(true);

            // Simulate Redis failure by closing the queue
            await redisQueue.close();

            // Should still return results even if queueing fails
            const result2 = await service.doWork('work-2');
            expect(result2.completed).toBe(true);

            // Check that error was logged
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to publish to queue')
            );

            // Reconnect Redis for cleanup
            const redisHost = redisContainer.getHost();
            const redisPort = redisContainer.getMappedPort(6379);
            redisQueue = new Queue('e2e-events', {
                connection: {host: redisHost, port: redisPort}
            });
        });
    });

    describe('🎯 Multi-Topic Routing', () => {
        it('should route messages to correct topics in Redis', async () => {
            // Clear previous jobs
            processedJobs = [];
            
            class MultiTopicService {
                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'orders',
                    useQueue: true
                })
                async createOrder(data: any) {
                    return {...data, type: 'order'};
                }

                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'analytics',
                    useQueue: true
                })
                async trackEvent(data: any) {
                    return {...data, type: 'analytics'};
                }

                @EmitOnSuccess({
                    queue: 'redis',
                    topic: 'notifications',
                    useQueue: true
                })
                async sendNotification(data: any) {
                    return {...data, type: 'notification'};
                }
            }

            const service = new MultiTopicService();

            // Execute methods with different topics
            await service.createOrder({orderId: 'ord-123'});
            await service.trackEvent({event: 'page_view'});
            await service.sendNotification({message: 'Welcome!'});

            // Wait for processing
            await new Promise(resolve => setTimeout(resolve, 300));

            expect(processedJobs).toHaveLength(3);

            // Verify topic routing
            const orderJob = processedJobs.find(job =>
                job.data.metadata.topic === 'orders'
            );
            expect(orderJob?.data.payload.type).toBe('order');

            const analyticsJob = processedJobs.find(job =>
                job.data.metadata.topic === 'analytics'
            );
            expect(analyticsJob?.data.payload.type).toBe('analytics');

            const notificationJob = processedJobs.find(job =>
                job.data.metadata.topic === 'notifications'
            );
            expect(notificationJob?.data.payload.type).toBe('notification');
        });
    });

    describe('📊 Performance & Monitoring', () => {
        it('should provide performance metrics for decorated methods', async () => {
            class MonitoredService {
                @tracking
                async heavyComputation(iterations: number) {
                    // Simulate heavy work
                    let result = 0;
                    for (let i = 0; i < iterations; i++) {
                        result += Math.random();
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));

                    return {
                        result: result.toFixed(4),
                        iterations,
                        completed: true
                    };
                }

                @EmitOnSuccess({
                    queue: 'redis',
                    useQueue: true,
                    queueMetadata: {performance: true}
                })
                async queueTask(data: any) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return {...data, processed: true};
                }
            }

            const service = new MonitoredService();

            const startTime = Date.now();
            const result = await service.heavyComputation(10000);
            const endTime = Date.now();

            expect(result.completed).toBe(true);
            expect(result.iterations).toBe(10000);

            // Test queued task
            await service.queueTask({test: 'performance'});

            // Verify tracking captured timing
            expect(mockTracker.track).toHaveBeenCalledWith(
                'MonitoredService.heavyComputation',
                expect.any(Number),
                false
            );

            const trackedDuration = mockTracker.track.mock.calls[0][1];
            expect(trackedDuration).toBeGreaterThan(100); // At least 100ms due to setTimeout
            expect(trackedDuration).toBeLessThan(5000); // Should be reasonable

            // Wait for queue processing
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(processedJobs).toHaveLength(1);
            expect(processedJobs[0].data.metadata.performance).toBe(true);

            console.log(`⏱️ Method took ${trackedDuration}ms (actual: ${endTime - startTime}ms)`);
        });
    });
}); 
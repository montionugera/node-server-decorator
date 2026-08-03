import {GenericContainer, StartedTestContainer} from 'testcontainers';
import * as amqp from 'amqplib';
import {
    globalQueueRegistry,
    RabbitMQAdapter,
    EmitOnSuccess
} from '../index';

// jest.config.js's per-project `testTimeout` key is silently ignored by Jest (not a valid
// per-project option in jest-config@29) — hooks/tests without their own inline override fall
// back to the 5000ms default. Set it explicitly for this container-backed suite (same pattern
// as cache-redis.e2e.spec.ts and queue-registry-redis-integration.e2e.spec.ts).
jest.setTimeout(60_000);

describe('🐰 EmitOnSuccess + RabbitMQ (Simple)', () => {
    let container: StartedTestContainer;
    let connection: any;
    let channel: any;
    let processedJobs: any[] = [];

    beforeAll(async () => {
        // Start RabbitMQ container
        container = await new GenericContainer('rabbitmq:3-management')
            .withExposedPorts(5672)
            .withEnvironment({
                'RABBITMQ_DEFAULT_USER': 'test',
                'RABBITMQ_DEFAULT_PASS': 'test'
            })
            .start();

        // Connect to RabbitMQ
        const connectionUrl = `amqp://test:test@${container.getHost()}:${container.getMappedPort(5672)}`;
        connection = await amqp.connect(connectionUrl);
        channel = await connection.createChannel();

        // Create test queue
        await channel.assertQueue('test-orders', { durable: true, autoDelete: true });

        console.log('✅ RabbitMQ container started');
    }, 60000);

    beforeEach(async () => {
        processedJobs = [];
        globalQueueRegistry.clear();
    });

    afterAll(async () => {
        try {
            if (channel) await channel.close();
            if (connection) await connection.close();
            if (container) await container.stop();
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }, 60000);

    it('should publish message to RabbitMQ when method succeeds', async () => {
        // Setup RabbitMQ adapter
        const rabbitAdapter = new RabbitMQAdapter(channel, 'test-orders', { autoDelete: true });
        globalQueueRegistry.register('orders', {
            adapter: rabbitAdapter,
            defaultTopic: 'orders'
        });
        globalQueueRegistry.setDefault('orders');

        // Simple test service
        class TestService {
            @EmitOnSuccess({
                useQueue: true,
                queue: 'orders',
                // ✅ No topic needed - uses defaultTopic automatically!
                queueMetadata: { test: true }
            })
            async processOrder(orderId: string): Promise<any> {
                return { id: orderId, status: 'processed' };
            }
        }

        // Setup consumer
        await channel.consume('test-orders', (msg: any) => {
            if (msg) {
                const content = JSON.parse(msg.content.toString());
                processedJobs.push(content);
                channel.ack(msg);
            }
        });

        // Execute test
        const service = new TestService();
        const result = await service.processOrder('test-123');

        // Wait for message processing
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify
        expect(result).toEqual({ id: 'test-123', status: 'processed' });
        expect(processedJobs).toHaveLength(1);
        expect(processedJobs[0].eventName).toBe('TestService.processOrder');
        expect(processedJobs[0].payload).toEqual(result);
        expect(processedJobs[0].metadata.test).toBe(true);

        console.log('✅ Message published to RabbitMQ successfully');
    }, 10000);
}); 
# Integration Tests

This directory contains end-to-end (e2e) integration tests that validate the complete decorator workflow with real external services.

## 📁 Test Files

### `emit-on-success-redis-testcontainers.e2e.spec.ts`
**Purpose**: Tests `@EmitOnSuccess` decorator with real Redis containers via Testcontainers
- 🐳 Spins up actual Redis container
- 🔄 Tests BullMQ job processing
- 🎯 Validates topic routing
- ⚡ Tests high-volume concurrent processing
- 🛡️ Error handling and recovery scenarios

### `queue-registry-redis-integration.e2e.spec.ts`
**Purpose**: Tests QueueRegistry and BullMQ adapter integration without complex decorator stacking
- 📊 Direct queue registry API testing
- 🚀 BullMQ adapter feature validation
- 🎯 Multi-topic message routing
- ⏱️ Performance and latency measurement
- 🛡️ Error resilience testing

### `multi-decorator-workflow.e2e.spec.ts`  
**Purpose**: Tests complete workflows with multiple decorators using in-memory queues
- 🛒 E-commerce order flow simulation
- 📚 Multiple decorator stacking (`@tracking`, `@cache`, `@EmitOnSuccess`)
- 🎛️ Multi-queue configuration testing
- 💾 In-memory queue validation (no Docker required)

## 🏗️ Test Infrastructure

### Prerequisites
- **Docker**: Required for Testcontainers-based tests
- **Node.js 20+**: For running tests
- **pnpm**: Package manager

### Dependencies
```json
{
  "testcontainers": "^11.4.0",
  "bullmq": "^5.34.0",
  "amqplib": "^0.10.4",
  "kafkajs": "^2.2.4"
}
```

## 🚀 Running Tests

### All E2E Tests
```bash
pnpm test:e2e
```

### Specific Test Suites
```bash
# Redis-specific tests (requires Docker)
pnpm test:e2e:redis

# Multi-decorator workflow (no Docker required)
pnpm test:e2e --testPathPattern=multi-decorator

# Queue registry integration  
pnpm test:e2e --testPathPattern=queue-registry
```

### Individual Test Files
```bash
# EmitOnSuccess + Redis + Testcontainers
pnpm test:e2e --testPathPattern=emit-on-success-redis-testcontainers

# Queue Registry + Redis integration
pnpm test:e2e --testPathPattern=queue-registry-redis-integration

# Multi-decorator workflows
pnpm test:e2e --testPathPattern=multi-decorator-workflow
```

## 📊 Test Scenarios

### 🛒 E-Commerce Flow
1. **Order Creation** → `@EmitOnSuccess` → Redis queue → `orders` topic
2. **Payment Processing** → Transform → Redis queue → `payments` topic  
3. **Analytics Tracking** → Queue only → `analytics` topic
4. **Notifications** → Events + Queue → `notifications` topic

### 🔄 Error Scenarios
- Redis connection failures
- Invalid queue configurations
- Decorator method errors
- High-volume stress testing

### ⚡ Performance Tests
- **Concurrent Processing**: 25+ simultaneous operations
- **Latency Measurement**: End-to-end timing
- **Throughput Testing**: High-volume message handling
- **Memory Usage**: Resource efficiency validation

## 🐳 Docker Setup

### Redis Container
```javascript
const redisContainer = await new GenericContainer('redis:7-alpine')
  .withExposedPorts(6379)
  .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
  .start();
```

### RabbitMQ Container (Future)
```javascript
const rabbitmqContainer = await new GenericContainer('rabbitmq:3-management')
  .withExposedPorts(5672, 15672)
  .withEnvironment({
    RABBITMQ_DEFAULT_USER: 'admin',
    RABBITMQ_DEFAULT_PASS: 'password'
  })
  .start();
```

## 📈 Test Architecture

```
E2E Tests
├── Testcontainers Layer
│   ├── Redis (BullMQ)
│   ├── RabbitMQ (planned)
│   └── Kafka (planned)
├── Integration Layer  
│   ├── QueueRegistry
│   ├── Queue Adapters
│   └── Topic Routing
└── Decorator Layer
    ├── @EmitOnSuccess
    ├── @tracking
    └── @cache
```

## 🎯 Test Coverage

### ✅ Currently Implemented
- **Redis/BullMQ Integration**: Full workflow testing
- **Queue Registry**: Multi-queue management
- **Topic Routing**: Message organization
- **Error Handling**: Graceful degradation
- **Performance**: Concurrent processing

### 🚧 Planned Extensions
- **RabbitMQ Integration**: AMQP message testing
- **Kafka Integration**: Stream processing validation
- **Database Integration**: Persistent cache testing
- **Load Testing**: Stress and performance limits

## 🎛️ Configuration

### Jest Configuration
```javascript
projects: [
  {
    displayName: 'e2e',
    testMatch: ['<rootDir>/src/integration/**/*.e2e.spec.ts'],
    testTimeout: 60000,
    preset: 'ts-jest',
    testEnvironment: 'node'
  }
]
```

### Running Specific Tests
```bash
# Test naming pattern: {feature}-{technology}-{type}.e2e.spec.ts
# Examples:
# - emit-on-success-redis-testcontainers.e2e.spec.ts
# - queue-registry-redis-integration.e2e.spec.ts  
# - multi-decorator-workflow.e2e.spec.ts
```

## 🏃‍♂️ Manual Testing Setup

### Local Redis
```bash
# Start Redis locally
docker run -d --name test-redis -p 6379:6379 redis:7-alpine

# Run integration tests
pnpm test:e2e:redis

# Cleanup
docker stop test-redis && docker rm test-redis
```

## 📋 Current Status

### ✅ Implemented
- **Test Infrastructure**: Complete setup with Testcontainers
- **Redis Integration**: Full BullMQ workflow testing
- **Multi-Queue Support**: QueueRegistry validation
- **Performance Testing**: Concurrent and latency tests
- **Error Scenarios**: Connection failures and recovery

### 🎯 Benefits
- **Real Infrastructure**: Tests against actual services
- **Comprehensive Coverage**: Full decorator workflow validation
- **CI/CD Ready**: Automated testing in GitHub Actions
- **Performance Validation**: Actual throughput and latency measurement
- **Production Confidence**: Real-world scenario testing

## 🔧 Implementation Notes

### Testcontainers Best Practices
- **Container Lifecycle**: Proper startup/shutdown in `beforeAll`/`afterAll`
- **Port Mapping**: Dynamic port allocation for parallel tests
- **Wait Strategies**: Ensure services are ready before testing
- **Resource Cleanup**: Automatic container cleanup on test completion

### Performance Considerations
- **Sequential Execution**: E2E tests run one at a time (`maxConcurrency: 1`)
- **Longer Timeouts**: 60-second timeout for container startup
- **Resource Management**: Proper cleanup to prevent resource leaks
- **Parallel Testing**: Unit tests run separately from E2E tests 
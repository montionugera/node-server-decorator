# Integration Tests

This directory contains integration tests for the server-decorator library using real infrastructure.

## Prerequisites

- Docker (for Testcontainers)
- pnpm package manager
- Node.js 20+

## Dependencies Installed

```bash
pnpm add -D testcontainers bullmq amqplib @types/amqplib
```

## Test Infrastructure

### Testcontainers
- **Redis**: `redis:7-alpine` - for BullMQ queue testing
- **RabbitMQ**: `rabbitmq:3-management-alpine` - for AMQP queue testing

### Test Scenarios Planned

#### 🔄 Queue Integration Tests
- **Redis/BullMQ Integration**
  - Real Redis container with BullMQ
  - EmitOnSuccess decorator with queue publishing
  - Job processing with workers
  - Concurrent processing tests
  - Error handling

- **RabbitMQ Integration**  
  - Real RabbitMQ container with AMQP
  - Message publishing and consuming
  - Durable queues and persistent messages
  - Connection error handling

#### 📊 Performance Tests
- High-throughput processing (50+ concurrent operations)
- Large payload handling (1000+ item datasets)
- Memory usage with real infrastructure
- Latency measurements

#### 🎯 Multi-Decorator Integration
- Combining `@tracking`, `@cache`, and `@EmitOnSuccess`
- Decorator order verification
- Error propagation through decorator stack

## Running Integration Tests

### Full Test Suite
```bash
pnpm test
```

### Unit Tests Only
```bash
pnpm jest --selectProjects unit
```

### Integration Tests Only  
```bash
pnpm jest --selectProjects integration
```

### With Docker Containers
```bash
# Ensure Docker is running
docker info

# Run integration tests (will start containers automatically)
pnpm jest src/integration --testTimeout=60000
```

## Manual Integration Testing

### Redis Setup
```bash
# Start Redis container
docker run -d -p 6379:6379 redis:7-alpine

# Test with BullMQ
node -e "
const { Queue } = require('bullmq');
const { BullMQAdapter, setGlobalQueue } = require('./dist/index');

const queue = new Queue('test', { connection: { host: 'localhost', port: 6379 } });
const adapter = new BullMQAdapter(queue);
setGlobalQueue(adapter);
console.log('Redis integration ready');
"
```

### RabbitMQ Setup
```bash
# Start RabbitMQ container
docker run -d -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=admin \
  -e RABBITMQ_DEFAULT_PASS=admin \
  rabbitmq:3-management-alpine

# Access management UI: http://localhost:15672 (admin/admin)

# Test with AMQP
node -e "
const amqp = require('amqplib');
const { RabbitMQAdapter, setGlobalQueue } = require('./dist/index');

(async () => {
  const conn = await amqp.connect('amqp://admin:admin@localhost');
  const channel = await conn.createChannel();
  const adapter = new RabbitMQAdapter(channel, 'test-queue');
  setGlobalQueue(adapter);
  console.log('RabbitMQ integration ready');
})();
"
```

## Current Status

✅ **Dependencies Installed**: testcontainers, bullmq, amqplib  
✅ **Jest Configuration**: Extended timeouts for container tests  
✅ **Test Architecture**: Separate unit and integration test projects  
⏳ **Test Implementation**: Ready for development  

## Implementation Notes

- TypeScript decorator stacking requires careful type handling
- Testcontainers handle automatic container lifecycle
- Tests run sequentially to avoid resource conflicts
- Extended timeouts account for container startup time
- Error scenarios test graceful degradation

## Benefits of Integration Testing

1. **Real Infrastructure**: Tests against actual Redis/RabbitMQ
2. **Confidence**: Validates decorator behavior in real conditions  
3. **Performance**: Measures actual throughput and latency
4. **Error Handling**: Tests connection failures and recovery
5. **Compatibility**: Ensures queue adapter implementations work

## Future Enhancements

- [ ] Implement actual test cases
- [ ] Add Kafka integration tests
- [ ] Performance benchmarking
- [ ] Chaos engineering scenarios
- [ ] Multi-service integration tests 
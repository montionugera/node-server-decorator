


# Server Decorator

A TypeScript library for server-side decorators with support for tracking, caching, events, and **intelligent multi-queue messaging**.

## Installation

```sh
# pnpm (recommended)
pnpm add server-decorator

# npm
npm install server-decorator

# yarn
yarn add server-decorator
```

## Features

- 🔍 **Method Tracking** - Track execution time and errors
- 💾 **Method Caching** - Cache method results with TTL
- 📢 **Event Emission** - Emit events on successful method execution  
- 🚀 **Queue Publishing** - Publish to multiple queues (Redis, RabbitMQ, Kafka)
- 🎯 **Multi-Queue Support** - Route messages to different queue backends
- ✨ **Smart Auto-Topics** - Automatic topic generation from `ClassName.methodName`
- 📊 **Topic Routing** - Organize messages by topics within queues
- ⚡ **Performance Optimized** - Built with pnpm and modern tooling
- 🧪 **Well Tested** - Unit tests + E2E tests with real infrastructure
- 🎨 **TypeScript Support** - Full type safety
- 💬 **Slack Notifications** - Automated release notifications to your team

## ✨ New! Auto-Topic Generation

**No more manual topic management!** Topics are now automatically generated from your class and method names:

```typescript
class OrderService {
  @EmitOnSuccess({ 
    useQueue: true,
    queue: 'redis'
    // ✨ No topic needed! Auto-generates "OrderService.createOrder"
  })
  async createOrder(customerId: string, items: any[]) {
    return { id: `ord-${Date.now()}`, customerId, items };
  }

  @EmitOnSuccess({ useQueue: true, queue: 'redis' })
  async processPayment(orderId: string) {
    // ✨ Auto-generates "OrderService.processPayment"
    return { orderId, status: 'paid' };
  }
}

// Results in perfectly organized message topics:
// 📮 OrderService.createOrder
// 📮 OrderService.processPayment
// 📮 UserService.register
// 📮 NotificationService.sendEmail
```

## Quick Start

```typescript
import { tracking, cache, EmitOnSuccess, globalQueueRegistry, BullMQAdapter } from 'server-decorator';
import { Queue } from 'bullmq';

// Setup Redis queue
const redisQueue = new Queue('events', { connection: { host: 'localhost', port: 6379 } });
globalQueueRegistry.register('redis', new BullMQAdapter(redisQueue));

class OrderService {
  @tracking
  @cache({ ttl: 300 })
  @EmitOnSuccess({ 
    queue: 'redis',
    useQueue: true,
    useEvents: true 
    // ✨ Topic auto-generated as "OrderService.createOrder"
  })
  async createOrder(customerId: string, items: any[], total: number) {
    // Your business logic
    return {
      id: `ord-${Date.now()}`,
      customerId,
      items,
      total,
      status: 'created'
    };
  }
}
```

## Usage

### Basic Decorators

```typescript
import { tracking, cache } from 'server-decorator';

class MyService {
  @tracking
  async processData(data: any) {
    // Automatically tracks execution time and errors
    return processedData;
  }

  @cache({ ttl: 300 }) // Cache for 5 minutes
  async expensiveOperation(id: string) {
    // Result cached automatically
    return await heavyComputation(id);
  }
}
```

### Event Emission with Auto-Topics

```typescript
import { EmitOnSuccess } from 'server-decorator';

class UserService {
  @EmitOnSuccess() // Events only, auto-topic: "UserService.createUser"
  async createUser(userData: any) {
    return newUser;
  }

  @EmitOnSuccess({ 
    useEvents: true,
    transform: (user) => ({ userId: user.id, email: user.email })
    // ✨ Auto-topic: "UserService.updateProfile"
  })
  async updateProfile(userId: string, data: any) {
    return updatedUser;
  }
}
```

### Smart Topic Organization

The **auto-topic generation** creates self-organizing message systems:

```typescript
class ECommerceService {
  @EmitOnSuccess({ useQueue: true, queue: 'analytics' })
  async trackUserAction(userId: string, action: string) {
    // 📮 Topic: "ECommerceService.trackUserAction"
    return { userId, action, timestamp: Date.now() };
  }

  @EmitOnSuccess({ useQueue: true, queue: 'notifications' })
  async sendWelcomeEmail(email: string) {
    // 📮 Topic: "ECommerceService.sendWelcomeEmail"
    return { email, sent: true };
  }

  @EmitOnSuccess({ 
    useQueue: true, 
    queue: 'orders',
    topic: 'urgent' // ✅ Manual override still works
  })
  async processUrgentOrder(orderId: string) {
    // 📮 Topic: "urgent" (manual override)
    return { orderId, priority: 'urgent' };
  }
}

// Perfect for microservices routing:
// ✅ Subscribe to all ECommerceService events: "ECommerceService.*"
// ✅ Subscribe to all tracking across services: "*.trackUserAction"  
// ✅ Subscribe to specific service actions: "ECommerceService.sendWelcomeEmail"
```

### Multi-Queue Configuration

```typescript
import { globalQueueRegistry, BullMQAdapter, RabbitMQAdapter } from 'server-decorator';

// Setup multiple queues with fallback topics
globalQueueRegistry.register('analytics', {
  adapter: new BullMQAdapter(redisQueue),
  defaultTopic: 'events', // Fallback if no auto-topic
  priority: 1
});

globalQueueRegistry.register('notifications', {
  adapter: new RabbitMQAdapter(rabbitmqChannel, 'notifications'),
  defaultTopic: 'alerts',
  priority: 2
});

// ✨ Now your decorators are super clean:
class PaymentService {
  @EmitOnSuccess({ queue: 'analytics', useQueue: true })
  async processPayment(amount: number) {
    // Auto-topic: "PaymentService.processPayment"
    return { amount, status: 'processed' };
  }

  @EmitOnSuccess({ queue: 'notifications', useQueue: true })
  async sendReceipt(email: string, amount: number) {
    // Auto-topic: "PaymentService.sendReceipt"
    return { email, amount };
  }
}
```

## Queue Configuration

### Redis/BullMQ Setup
```typescript
import { Queue } from 'bullmq';
import { BullMQAdapter, globalQueueRegistry } from 'server-decorator';

const queue = new Queue('my-events', {
  connection: { host: 'localhost', port: 6379 }
});

globalQueueRegistry.register('redis', new BullMQAdapter(queue));
globalQueueRegistry.setDefault('redis');
```

### RabbitMQ Setup
```typescript
import * as amqp from 'amqplib';
import { RabbitMQAdapter, globalQueueRegistry } from 'server-decorator';

const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createChannel();

globalQueueRegistry.register('rabbitmq', new RabbitMQAdapter(channel, 'events'));
```

### In-Memory Queue (Testing)
```typescript
import { InMemoryQueueAdapter, globalQueueRegistry } from 'server-decorator';

globalQueueRegistry.register('memory', new InMemoryQueueAdapter());
```

## Topic Generation Rules

### 🎯 **Smart Priority System:**
1. **Manual Override** - `topic: 'custom'` (when you need control)
2. **Auto-Generated** - `ClassName.methodName` (perfect default)
3. **Queue Default** - `defaultTopic` from queue config (fallback)

### 📊 **Real-World Examples:**
```typescript
// Perfect microservice organization:
UserService.register         → User registration events
UserService.login           → Authentication events  
OrderService.create         → Order creation events
OrderService.updateStatus   → Order status changes
PaymentService.charge       → Payment processing
NotificationService.email   → Email notifications

// Easy routing patterns:
"UserService.*"             → All user events
"*.create"                  → All creation events  
"OrderService.updateStatus" → Specific order updates
```

## Development

### Package Manager
This project uses **pnpm** for dependency management:

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run e2e tests (requires Docker)
pnpm test:e2e

# Build
pnpm run build

# Development mode
pnpm run dev
```

### Testing

#### Unit Tests
```bash
pnpm test:unit
```
Runs fast unit tests for all decorators and core functionality, with coverage. The run fails if line coverage of `src/` (excluding specs and `src/integration/`) drops below the `coverageThreshold` in `jest.config.js` (98). `pnpm test` and `pnpm test:e2e` collect no coverage.

#### E2E Tests
```bash
# Requires Docker to be running
pnpm test:e2e

# Redis-specific e2e tests
pnpm test:e2e:redis
```

The E2E tests use **Testcontainers** to spin up real Redis and RabbitMQ instances, providing comprehensive integration testing.

#### Test Infrastructure
- **Unit Tests**: Jest with ts-jest for TypeScript
- **E2E Tests**: Testcontainers for real infrastructure
- **Coverage**: Comprehensive test coverage with real queue backends
- **CI/CD**: GitHub Actions with pnpm for fast builds

### Architecture

#### Multi-Queue System with Auto-Topics
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   @EmitOnSuccess │───▶│  QueueRegistry  │───▶│   Queue Adapters │
│   Decorator     │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                       │                        │
        ▼                       ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Auto Topic     │    │ Topic Routing   │    │Redis/RabbitMQ   │
│  Generation     │    │ ClassName.method│    │   /Kafka        │
│ ClassName.method│    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

#### Decorator Stacking
```typescript
class Service {
  @tracking           // 3. Performance monitoring
  @cache({ ttl: 300 }) // 2. Caching layer  
  @EmitOnSuccess({    // 1. Event/Queue publishing
    useQueue: true
    // ✨ Auto-topic: "Service.processOrder"
  })
  async processOrder(data: any) {
    // Your business logic
  }
}
```

## CI/CD

This package is part of the polyglot `server-decorator` repo and shares its workflows. See [`.github/workflows/`](../../../.github/workflows/) at the repo root for:

- `ci-node.yml` — unit + (label-gated) e2e on every Node-touching PR.
- `ci-contracts.yml` — JSON-schema fixture validation + Node↔Python version-match enforcement.
- `ci-interop.yml` — cross-language interop scenarios (heavy; runs on `push: main`, weekly schedule, or `run-interop` PR label).
- `publish-node.yml` — tag-driven npm publish.

Releasing both packages happens in lock-step via `scripts/bump-version.sh patch|minor|major` from the repo root, then `git push --tags`. See [`MIGRATION.md`](../../../MIGRATION.md) for the v1.x → v2.0.0 upgrade guide.

## Consuming events

```typescript
import { ConsumerRegistry, RedisStreamConsumer, OnEvent, registerHandlers } from '@montionugera/server-decorator'
import Redis from 'ioredis'

const registry = new ConsumerRegistry()
registry.register('orders', new RedisStreamConsumer(new Redis('redis://localhost:6379'), { stream: 'orders', group: 'email-svc' }))

class OrderHandlers {
  @OnEvent('OrderService.createOrder', { consumer: 'orders' })
  async sendEmail(payload: any, meta: any) {
    // return -> ack; throw -> redelivered
  }
}
registerHandlers(new OrderHandlers())

await registry.start()
// ... app runs ...
await registry.stop()
```

**Delivery is at-least-once** — handlers must be idempotent; ordering is not
guaranteed under redelivery. Unparseable messages are acked + skipped; only
handler failures stay pending for retry. `@OnEvent` uses stage-2 decorators
(`experimentalDecorators`); if you transpile with esbuild/tsx, register handlers
imperatively with `registry.on('Event.name', handler, { consumer: 'orders' })`.

### Available consumers

| Consumer | Dependency |
|----------|------------|
| `RedisStreamConsumer` | built-in (`ioredis`) |
| `KafkaConsumer` | requires `kafkajs` |
| `RabbitMQConsumer` | requires `amqplib` |
| `BullMQConsumer` | requires `bullmq` |

All backends deliver **at-least-once**, so handlers must be idempotent; failed
messages stay pending/unacked (Redis/RabbitMQ) or are retried per attempts
(Kafka offset is not committed / BullMQ job `attempts`).

`KafkaConsumer` rewinds the partition to a failed offset after `retryBackoffMs`
(default 1000 ms), so the record is redelivered before anything later is
committed. A record that always fails therefore blocks its partition; route it
to a dead-letter topic inside the handler if that is not what you want.

`ConsumerRegistry.start()` logs a consumer whose `run()` fails instead of
raising an unhandled rejection. The other consumers keep running; the failed
one is not restarted.

A traced message is handled inside its own exported span, named
`consume <eventName>` (`span.kind = CONSUMER`), whose parent is the producer span.

## Behaviour notes

- **Emit never changes the method's outcome.** If `transform` throws, the error
  is logged and both the event and the queue publish are skipped; the caller
  still gets the method's result.
- **Queue resolution.** `QueueRegistry.publish()` with no queue name uses the
  default queue, or the first registered queue if no default was set. An unknown
  *named* queue is not published (fail closed). `publish()` resolves to `true`
  only when the message was handed to an adapter.
- **Lost lock lease.** `@distributedLock` throws `LockLostError` after the method
  settles if the lease was lost while it ran (the method's own error, if any, is
  on `cause`). A renewal that errors is retried on the next tick; the lease
  counts as lost on a definite refusal or after a full TTL with no confirmed
  renewal. The token-guarded release is always attempted.
- **Tracing.** A `traceparent` must be version `00` with lower-case hex; anything
  else is ignored and a new trace starts. A throwing `attributes` extractor is
  logged and never fails the method. Any thrown value marks the span `ERROR`.
- **Cache.** A failing adapter `set` is logged and the result is still returned;
  a failing `get` propagates. NaN / Infinity arguments throw a `TypeError`.

## Contributing

1. Ensure Docker is running for E2E tests
2. Use pnpm for dependency management
3. Run `pnpm test` before committing
4. Follow the existing decorator patterns

## License

MIT

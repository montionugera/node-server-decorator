


# Server Decorator

A TypeScript library for server-side decorators with support for tracking, caching, events, and multi-queue messaging.

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
- 📊 **Topic Routing** - Organize messages by topics within queues
- ⚡ **Performance Optimized** - Built with pnpm and modern tooling
- 🧪 **Well Tested** - Unit tests + E2E tests with real infrastructure
- 🎨 **TypeScript Support** - Full type safety
- 💬 **Slack Notifications** - Automated release notifications to your team

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
    topic: 'orders',
    useQueue: true,
    useEvents: true 
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

### Event Emission

```typescript
import { EmitOnSuccess } from 'server-decorator';

class UserService {
  @EmitOnSuccess() // Events only
  async createUser(userData: any) {
    return newUser;
  }

  @EmitOnSuccess({ 
    useEvents: true,
    transform: (user) => ({ userId: user.id, email: user.email })
  })
  async updateProfile(userId: string, data: any) {
    return updatedUser;
  }
}
```

### Multi-Queue Configuration

```typescript
import { globalQueueRegistry, BullMQAdapter, RabbitMQAdapter } from 'server-decorator';

// Setup multiple queues
globalQueueRegistry.register('analytics', {
  adapter: new BullMQAdapter(redisQueue),
  topics: ['user-events', 'page-views'],
  priority: 1
});

globalQueueRegistry.register('notifications', {
  adapter: new RabbitMQAdapter(rabbitmqChannel, 'notifications'),
  topics: ['email', 'sms', 'push'],
  priority: 2
});

class ECommerceService {
  @EmitOnSuccess({ 
    queue: 'analytics', 
    topic: 'user-events',
    useQueue: true 
  })
  async trackUserAction(userId: string, action: string) {
    return { userId, action, timestamp: Date.now() };
  }

  @EmitOnSuccess({ 
    queue: 'notifications', 
    topic: 'email',
    useQueue: true 
  })
  async sendWelcomeEmail(email: string) {
    return { email, sent: true };
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
Runs fast unit tests for all decorators and core functionality.

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

#### Multi-Queue System
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   @EmitOnSuccess │───▶│  QueueRegistry  │───▶│   Queue Adapters │
│   Decorator     │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │                        │
                              ▼                        ▼
                       ┌─────────────┐         ┌─────────────┐
                       │Topic Routing│         │Redis/RabbitMQ│
                       │             │         │   /Kafka    │
                       └─────────────┘         └─────────────┘
```

#### Decorator Stacking
```typescript
class Service {
  @tracking           // 3. Performance monitoring
  @cache({ ttl: 300 }) // 2. Caching layer  
  @EmitOnSuccess({    // 1. Event/Queue publishing
    useQueue: true,
    topic: 'orders'
  })
  async processOrder(data: any) {
    // Your business logic
  }
}
```

## GitHub Actions & CI/CD

The project includes automated CI/CD with GitHub Actions:

- **✅ Automated Testing**: Unit and E2E tests on every PR
- **🚀 Auto-Publishing**: NPM package publishing on version changes
- **💬 Slack Notifications**: Team notifications for releases and failures
- **⚡ pnpm Optimization**: Fast installs with intelligent caching
- **🐳 Container Tests**: Real Redis/RabbitMQ testing in CI

### Workflows
- `.github/workflows/publish.yml` - Build, test, publish, and notify
- `.github/workflows/version-bump.yml` - Version management

### Slack Integration
Get notified when new versions are published! The CI/CD pipeline automatically sends rich notifications to your Slack channels.

```bash
🚀 New Release Published!
📦 Package: server-decorator v1.2.3
📦 NPM: View on NPM
💾 Install: pnpm add server-decorator@1.2.3
📖 Release Notes: View Release Notes
```

**Setup Instructions**: See [`.github/SLACK_SETUP.md`](.github/SLACK_SETUP.md) for complete setup guide.

**Required**: Add `SLACK_WEBHOOK_URL` secret to your GitHub repository settings.

## Contributing

1. Ensure Docker is running for E2E tests
2. Use pnpm for dependency management
3. Run `pnpm test` before committing
4. Follow the existing decorator patterns

## License

MIT

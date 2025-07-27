


# Server Decorator

A TypeScript library for server-side decorators with support for tracking, caching, events, and queuing.

## Installation

To install the package, use npm or yarn:

```sh
npm install server-decorator
```

or

```sh
yarn add server-decorator
```

## Features

- 🔍 **Method Tracking** - Track execution time and errors
- 💾 **Method Caching** - Cache method results with TTL
- 📢 **Event Emission** - Emit events on successful method execution  
- 🚀 **Queue Publishing** - Publish to queues (Redis, RabbitMQ, etc.)
- 🎯 **TypeScript Support** - Full type safety
- 🧪 **Well Tested** - Comprehensive test coverage

## Usage

### Importing the Decorators

```typescript
import { 
  tracking, 
  cache, 
  EmitOnSuccess,
  setGlobalQueue,
  BullMQAdapter 
} from 'server-decorator';
```

## Decorators

### 🔍 Tracking Decorator

Track method execution time and errors:

```typescript
import { tracking } from 'server-decorator';

class ExampleService {
  @tracking
  async getData() {
    // Your implementation here
    return { data: 'example' };
  }
}
```

### 💾 Cache Decorator

Cache method results with TTL:

```typescript
import { cache } from 'server-decorator';

class ExampleService {
  @cache(cacheAdapter, 300) // 5 minutes TTL
  async getData() {
    // Expensive operation
    return { data: 'cached result' };
  }
}
```

### 📢 EmitOnSuccess Decorator

Emit events and/or publish to queues when methods succeed:

#### Basic Event Emission
```typescript
import { EmitOnSuccess } from 'server-decorator';

class UserService {
  @EmitOnSuccess()
  async createUser(userData: any) {
    // Creates user and emits 'UserService.createUser' event
    return { id: 1, ...userData };
  }
}
```

#### Queue Publishing Only
```typescript
class UserService {
  @EmitOnSuccess({ 
    useQueue: true, 
    useEvents: false,
    queueMetadata: { priority: 'high' }
  })
  async sendWelcomeEmail(userId: number) {
    // Publishes to queue instead of emitting event
    return { sent: true, userId };
  }
}
```

#### Both Events and Queues
```typescript
class UserService {
  @EmitOnSuccess({ 
    useQueue: true, 
    useEvents: true,
    transform: (result) => ({ ...result, processed: true }),
    queueMetadata: { source: 'user-service' }
  })
  async updateProfile(userId: number, data: any) {
    // Both emits event AND publishes to queue
    return { userId, ...data };
  }
}
```

## Queue Configuration

### Redis/BullMQ Setup
```typescript
import { Queue } from 'bullmq';
import { BullMQAdapter, setGlobalQueue } from 'server-decorator';

const redisQueue = new Queue('events', {
  connection: { host: 'localhost', port: 6379 }
});

const queueAdapter = new BullMQAdapter(redisQueue);
setGlobalQueue(queueAdapter);
```

### RabbitMQ Setup
```typescript
import amqp from 'amqplib';
import { RabbitMQAdapter, setGlobalQueue } from 'server-decorator';

const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createChannel();
await channel.assertQueue('events', { durable: true });

const queueAdapter = new RabbitMQAdapter(channel, 'events');
setGlobalQueue(queueAdapter);
```

### In-Memory Queue (Testing)
```typescript
import { InMemoryQueueAdapter, setGlobalQueue } from 'server-decorator';

const queueAdapter = new InMemoryQueueAdapter();
setGlobalQueue(queueAdapter);
```

## Configuration

### Global Logger
```typescript
import { setGlobalLogger } from 'server-decorator';

setGlobalLogger({
  debug: (msg) => console.debug(msg),
  info: (msg) => console.info(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
});
```

### Global Tracker
```typescript
import { setGlobalTracker } from 'server-decorator';

setGlobalTracker({
  track: (key: string, latency: number, isError: boolean) => {
    // Send metrics to your monitoring system
  }
});
```

## TypeScript Support

All decorators are fully typed and provide excellent TypeScript intellisense and type checking.

## License

ISC

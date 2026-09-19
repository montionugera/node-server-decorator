// Contract version — mirrors `contracts/VERSION`.
export { CONTRACT_VERSION } from './_contract';

// Decorators
export { tracking } from './decorators/tracking';
export { cache, CACHE_MISS, type CacheAdapter, type CacheMiss } from './decorators/cache';
export { buildCacheKey, MAX_KEY_BYTES } from './decorators/_cache_key';
export { EmitOnSuccess } from './decorators/emit-on-success';

// Global utilities
export { setGlobalLogger, globalLogger } from './logger';
export { setGlobalTracker, globalTracker } from './tracker';
export { globalEmitter, setGlobalEmitter } from './decorators/global-emitter';

// Queue system
export { 
  globalQueue, 
  setGlobalQueue, 
  hasGlobalQueue, 
  QueueAdapter, 
  QueueMessage 
} from './decorators/global-queue';

export { 
  QueueRegistry,
  QueueConfig,
  globalQueueRegistry 
} from './decorators/queue-registry';

// Queue adapters
export { 
  BullMQAdapter, 
  RabbitMQAdapter, 
  KafkaAdapter,
  InMemoryQueueAdapter 
} from './decorators/queue-adapters';

// NoOp adapter for fallback
export { NoOpQueueAdapter } from './decorators/global-queue';

// Config
export { configure, getService } from './config';

// Consumer system
export {
  ConsumerRegistry,
  InMemoryConsumer,
  globalConsumerRegistry,
  type ConsumerAdapter,
  type EventHandler,
} from './decorators/consumer-registry';
export { RedisStreamConsumer, KafkaConsumer, RabbitMQConsumer, BullMQConsumer } from './decorators/consumer-adapters';
export { OnEvent, registerHandlers } from './decorators/on-event';

// SSE Transport
export {
  SSEBroadcaster,
  formatSSEMessage,
  type SSEEvent,
  type SSEBroadcasterOptions,
  type SSEClientResponse,
} from './sse/broadcaster';

// Scoped Auth Middleware
export {
  scopeAuthMiddleware,
  checkScopes,
  type ProblemDetails,
  type ScopeExtractor,
  type ScopeAuthOptions,
} from './middleware/scope-auth';

// Resilience Suite
export { retry, type RetryOptions } from './decorators/retry';
export {
  circuitBreaker,
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  getCircuitBreaker,
  clearCircuitBreakerRegistry,
  type CircuitBreakerOptions,
} from './decorators/circuit-breaker';
export {
  rateLimit,
  TokenBucket,
  RateLimitExceededError,
  clearRateLimitRegistry,
  type RateLimitOptions,
} from './decorators/rate-limit';

// Reactive Call Coalescing
export { batchLoad, type BatchLoadOptions, type PrefetchRule } from './decorators/batch-load';


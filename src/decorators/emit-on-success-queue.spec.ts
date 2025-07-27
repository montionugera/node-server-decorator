import { EmitOnSuccess } from './emit-on-success';
import { setGlobalQueue, globalQueue } from './global-queue';
import { InMemoryQueueAdapter } from './queue-adapters';
import { setGlobalLogger } from '../logger';

// Mock logger for testing
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

describe('EmitOnSuccess with Queue Support', () => {
  let queueAdapter: InMemoryQueueAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    setGlobalLogger(mockLogger);
    queueAdapter = new InMemoryQueueAdapter();
    setGlobalQueue(queueAdapter);
  });

  afterEach(() => {
    queueAdapter.clear();
  });

  class TestService {
    @EmitOnSuccess()
    async defaultBehavior() {
      return { success: true };
    }

    @EmitOnSuccess({ useQueue: true, useEvents: false })
    async queueOnly() {
      return { queued: true };
    }

    @EmitOnSuccess({ 
      useQueue: true, 
      useEvents: true,
      queueMetadata: { priority: 'high' }
    })
    async bothEventAndQueue() {
      return { both: true };
    }

    @EmitOnSuccess({ 
      useQueue: true,
      transform: (result) => ({ ...result, transformed: true })
    })
    async withTransform() {
      return { original: true };
    }
  }

  it('should publish to queue when useQueue is enabled', async () => {
    const service = new TestService();
    await service.queueOnly();

    const messages = queueAdapter.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      eventName: 'TestService.queueOnly',
      payload: { queued: true },
      metadata: {
        className: 'TestService',
        methodName: 'queueOnly'
      }
    });
  });

  it('should include custom metadata in queue message', async () => {
    const service = new TestService();
    await service.bothEventAndQueue();

    const messages = queueAdapter.getMessages();
    expect(messages[0].metadata).toMatchObject({
      priority: 'high',
      className: 'TestService',
      methodName: 'bothEventAndQueue'
    });
  });

  it('should apply transform function to queue payload', async () => {
    const service = new TestService();
    await service.withTransform();

    const messages = queueAdapter.getMessages();
    expect(messages[0].payload).toEqual({
      original: true,
      transformed: true
    });
  });

  it('should warn when queue is requested but not configured', async () => {
    setGlobalQueue(null);
    const service = new TestService();
    await service.queueOnly();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Queue requested but no globalQueue configured')
    );
  });

  it('should handle queue publish errors gracefully', async () => {
    const errorQueue = {
      publish: jest.fn().mockRejectedValue(new Error('Queue error'))
    };
    setGlobalQueue(errorQueue);

    const service = new TestService();
    await service.queueOnly();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish to queue')
    );
  });

  it('should work with sync methods', async () => {
    class SyncTestService {
      @EmitOnSuccess({ useQueue: true })
      syncMethod() {
        return { sync: true };
      }
    }

    const service = new SyncTestService();
    service.syncMethod();

    // Wait a bit for async queue handling
    await new Promise(resolve => setTimeout(resolve, 10));

    const messages = queueAdapter.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual({ sync: true });
  });
}); 
import { NativeModules } from 'react-native';
import Dispatcher from '../../dispatcher';
import CircuitBreaker from '../../utils/circuitBreaker';

function mockNativeStorage() {
  const store: { data: string | null } = { data: null };
  NativeModules.MetaRouterQueueStorage = {
    exists: jest.fn(async () => store.data !== null),
    readSnapshot: jest.fn(async () => store.data),
    writeSnapshot: jest.fn(async (data: string) => {
      store.data = data;
    }),
    deleteSnapshot: jest.fn(async () => {
      store.data = null;
    }),
  };
  return { store, mock: NativeModules.MetaRouterQueueStorage };
}

function createDispatcher(overrides?: Partial<any>) {
  return new Dispatcher({
    maxEventCount: 2000,
    maxQueueBytes: 5 * 1024 * 1024,
    autoFlushThreshold: 9999,
    maxBatchSize: 100,
    flushIntervalSeconds: 3600,
    baseRetryDelayMs: 1000,
    maxRetryDelayMs: 8000,
    isPersistenceEnabled: () => true,
    isNetworkAvailable: () => true,
    endpoint: (p: string) => `https://example.com${p}`,
    fetchWithTimeout: jest.fn(async () => ({ ok: true, status: 200 }) as any),
    canSend: () => true,
    isOperational: () => true,
    isTracingEnabled: () => false,
    createBreaker: () =>
      new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 8000,
        jitterRatio: 0,
        halfOpenMaxConcurrent: 1,
      }),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ...overrides,
  });
}

describe('PersistentEventQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
  });

  describe('checkForPersistedEvents', () => {
    it('sets hasDiskData=true when the snapshot file exists', async () => {
      const { store } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const result = await pq.checkForPersistedEvents();
      expect(result).toBe(true);
      expect(pq.hasDiskData).toBe(true);
      // Memory queue stays empty — no load on boot.
      expect(dispatcher.getQueueRef().length).toBe(0);
    });

    it('sets hasDiskData=false when there is no snapshot', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const result = await pq.checkForPersistedEvents();
      expect(result).toBe(false);
      expect(pq.hasDiskData).toBe(false);
    });

    it('does not read the snapshot file (cheap exists-only check)', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.checkForPersistedEvents();

      expect(mock.exists).toHaveBeenCalled();
      expect(mock.readSnapshot).not.toHaveBeenCalled();
    });

    it('returns false if the exists check throws', async () => {
      mockNativeStorage();
      (
        NativeModules.MetaRouterQueueStorage as any
      ).exists.mockRejectedValueOnce(new Error('boom'));

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const result = await pq.checkForPersistedEvents();
      expect(result).toBe(false);
      expect(pq.hasDiskData).toBe(false);
    });
  });

  describe('flushToDisk', () => {
    it('drains memory queue and appends to disk as versioned JSON', async () => {
      const { mock, store } = mockNativeStorage();

      const dispatcher = createDispatcher();
      dispatcher.enqueue({
        type: 'track',
        event: 'mem1',
        messageId: 'a',
      } as any);
      dispatcher.enqueue({
        type: 'track',
        event: 'mem2',
        messageId: 'b',
      } as any);

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushToDisk();

      expect(mock.writeSnapshot).toHaveBeenCalledTimes(1);
      const written = JSON.parse(store.data!);
      expect(written.version).toBe(1);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('mem1');
      expect(dispatcher.getQueueRef().length).toBe(0);
      expect(pq.hasDiskData).toBe(true);
    });

    it('is a no-op when memory queue is empty', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushToDisk();

      expect(mock.writeSnapshot).not.toHaveBeenCalled();
      expect(mock.deleteSnapshot).not.toHaveBeenCalled();
    });

    it('merges memory events with existing disk events', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'disk1' }],
      });

      const dispatcher = createDispatcher();
      dispatcher.enqueue({ type: 'track', event: 'mem1' } as any);

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushToDisk();

      const written = JSON.parse(store.data!);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('disk1');
      expect(written.events[1].event).toBe('mem1');
    });
  });

  describe('shouldFlushToDisk', () => {
    it('returns false when below byte threshold', () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      for (let i = 0; i < 10; i++) {
        dispatcher.enqueue({ type: 'track', event: `e${i}` } as any);
      }

      expect(pq.shouldFlushToDisk()).toBe(false);
    });

    it('returns true when byte size exceeds threshold', () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const bigProps: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        bigProps[`key${i}`] = 'x'.repeat(100);
      }

      for (let i = 0; i < 1000; i++) {
        dispatcher.enqueue({
          type: 'track',
          event: `e${i}`,
          properties: bigProps,
        } as any);
      }

      expect(pq.shouldFlushToDisk()).toBe(true);
    });
  });

  describe('deleteSnapshot', () => {
    it('delegates to native module and clears hasDiskData', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      // Force hasDiskData=true by flushing something first
      dispatcher.enqueue({ type: 'track', event: 'e1' } as any);
      await pq.flushToDisk();
      expect(pq.hasDiskData).toBe(true);

      await pq.deleteSnapshot();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(pq.hasDiskData).toBe(false);
    });
  });

  describe('flushEventsToDisk', () => {
    it('writes events to disk store', async () => {
      const { store } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushEventsToDisk([
        { type: 'track', event: 'o1' },
        { type: 'track', event: 'o2' },
      ]);

      const written = JSON.parse(store.data!);
      expect(written.version).toBe(1);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('o1');
    });

    it('merges with existing events on disk', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'existing1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushEventsToDisk([{ type: 'track', event: 'new1' }]);

      const written = JSON.parse(store.data!);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('existing1');
      expect(written.events[1].event).toBe('new1');
    });

    it('enforces disk cap when merging', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 4 }, (_, i) => ({
          type: 'track',
          event: `old${i}`,
        })),
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher, {
        maxDiskEvents: 5,
      });

      await pq.flushEventsToDisk([
        { type: 'track', event: 'new1' },
        { type: 'track', event: 'new2' },
      ]);

      const written = JSON.parse(store.data!);
      expect(written.events.length).toBe(5);
      expect(written.events[0].event).toBe('old1');
    });

    it('is a no-op when events array is empty', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushEventsToDisk([]);

      expect(mock.writeSnapshot).not.toHaveBeenCalled();
    });

    it('serializes concurrent writes (no races)', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const p1 = pq.flushEventsToDisk([{ type: 'track', event: 'a' }]);
      const p2 = pq.flushEventsToDisk([{ type: 'track', event: 'b' }]);

      await Promise.all([p1, p2]);

      expect(mock.writeSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('drainDiskToNetwork', () => {
    it('sends disk events directly to network without entering memory queue', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'disk1' },
          { type: 'track', event: 'disk2' },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(dispatcher.getQueueRef().length).toBe(0);
      expect((dispatcher as any).opts.fetchWithTimeout).toHaveBeenCalled();
    });

    it('deletes disk file after drain and clears hasDiskData', async () => {
      const { store, mock } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.checkForPersistedEvents();
      expect(pq.hasDiskData).toBe(true);

      await pq.drainDiskToNetwork(dispatcher);

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(store.data).toBeNull();
      expect(pq.hasDiskData).toBe(false);
    });

    it('stops on 5xx server error', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 5 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      const fetchMock = jest.fn(async () => ({
        ok: false,
        status: 500,
      }));
      const dispatcher = createDispatcher({
        fetchWithTimeout: fetchMock,
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(store.data).not.toBeNull();
      const remaining = JSON.parse(store.data!);
      expect(remaining.events.length).toBe(5);
    });

    it('stops on 429 rate limit', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async () => ({
          ok: false,
          status: 429,
        })),
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(store.data).not.toBeNull();
    });

    it('halves batch size on 413 and retries', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 200 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      const batchSizes: number[] = [];
      let callCount = 0;
      const fetchMock = jest.fn(async (_url?: string, init?: any) => {
        callCount++;
        const batchLen = JSON.parse(init.body).batch.length;
        batchSizes.push(batchLen);
        if (callCount === 1) {
          return { ok: false, status: 413 };
        }
        return { ok: true, status: 200 };
      });

      const dispatcher = createDispatcher({ fetchWithTimeout: fetchMock });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(batchSizes).toEqual([100, 50, 100, 50]);
      expect(store.data).toBeNull();
    });

    it('drops events on 413 at batchSize=1', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'big_event', messageId: 'msg1' },
          { type: 'track', event: 'normal_event', messageId: 'msg2' },
        ],
      });

      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async () => ({
          ok: false,
          status: 413,
        })),
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(store.data).toBeNull();
    });

    it('deletes disk store on fatal config error (401/403/404)', async () => {
      const { store, mock } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async () => ({
          ok: false,
          status: 403,
        })),
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(store.data).toBeNull();
    });

    it('fires onFatalConfig handler on 401/403/404 during drain', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const onFatalConfig = jest.fn();
      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async () => ({
          ok: false,
          status: 401,
        })),
        onFatalConfig,
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(onFatalConfig).toHaveBeenCalledTimes(1);
    });

    it('drops batch on other 4xx and continues draining', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 150 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      let callCount = 0;
      const fetchMock = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 400 };
        }
        return { ok: true, status: 200 };
      });

      const dispatcher = createDispatcher({ fetchWithTimeout: fetchMock });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.data).toBeNull();
    });

    it('restores batch size after success following 413', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 300 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      const batchSizes: number[] = [];
      let callCount = 0;
      const fetchMock = jest.fn(async (_url?: string, init?: any) => {
        callCount++;
        const batchLen = JSON.parse(init.body).batch.length;
        batchSizes.push(batchLen);
        if (callCount === 1) return { ok: false, status: 413 };
        return { ok: true, status: 200 };
      });

      const dispatcher = createDispatcher({ fetchWithTimeout: fetchMock });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(batchSizes[0]).toBe(100);
      expect(batchSizes[1]).toBe(50);
      expect(batchSizes[2]).toBe(100);
    });

    it('drains in batches of 100', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 250 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      const fetchCalls: number[] = [];
      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async (_url?: string, init?: any) => {
          fetchCalls.push(JSON.parse(init.body).batch.length);
          return { ok: true, status: 200 } as any;
        }),
      });

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(fetchCalls).toEqual([100, 100, 50]);
      expect(store.data).toBeNull();
    });

    it('is a no-op when no disk file exists', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect((dispatcher as any).opts.fetchWithTimeout).not.toHaveBeenCalled();
    });

    it('filters expired events during drain', async () => {
      const { store } = mockNativeStorage();

      const eightDaysAgo = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000
      ).toISOString();
      const oneDayAgo = new Date(
        Date.now() - 1 * 24 * 60 * 60 * 1000
      ).toISOString();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'expired', timestamp: eightDaysAgo },
          { type: 'track', event: 'fresh', timestamp: oneDayAgo },
        ],
      });

      let sentBatch: any[] = [];
      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async (_url?: string, init?: any) => {
          sentBatch = JSON.parse(init.body).batch;
          return { ok: true, status: 200 } as any;
        }),
      });

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(sentBatch.length).toBe(1);
      expect(sentBatch[0].event).toBe('fresh');
    });

    it('keeps events with unparseable timestamps during drain', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'no_ts' },
          { type: 'track', event: 'bad_ts', timestamp: 'not-a-date' },
        ],
      });

      let sentBatch: any[] = [];
      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async (_url?: string, init?: any) => {
          sentBatch = JSON.parse(init.body).batch;
          return { ok: true, status: 200 } as any;
        }),
      });

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(sentBatch.length).toBe(2);
    });

    it('stops on network/transport error (null response)', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher({
        fetchWithTimeout: jest.fn(async () => {
          throw new Error('Network unavailable');
        }),
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(store.data).not.toBeNull();
    });

    it('concurrent drains coalesce into one', async () => {
      const { store } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: Array.from({ length: 3 }, (_, i) => ({
          type: 'track',
          event: `e${i}`,
        })),
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const [a, b] = await Promise.all([
        pq.drainDiskToNetwork(dispatcher),
        pq.drainDiskToNetwork(dispatcher),
      ]);
      expect(a).toBe(b);
      expect((dispatcher as any).opts.fetchWithTimeout).toHaveBeenCalledTimes(
        1
      );
    });
  });

  describe('full round-trip (persist → drain)', () => {
    it('flushToDisk persists events, drainDiskToNetwork sends them', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue({
          type: 'track',
          event: `e${i}`,
          properties: { i },
        } as any);
      }

      await pq.flushToDisk();
      expect(pq.hasDiskData).toBe(true);

      const dispatcher2 = createDispatcher();
      const pq2 = new PersistentEventQueue(dispatcher2);

      await pq2.checkForPersistedEvents();
      expect(pq2.hasDiskData).toBe(true);

      await pq2.drainDiskToNetwork(dispatcher2);

      // All 5 events delivered via a single batch
      expect((dispatcher2 as any).opts.fetchWithTimeout).toHaveBeenCalledTimes(
        1
      );
      const body = JSON.parse(
        (dispatcher2 as any).opts.fetchWithTimeout.mock.calls[0][1].body
      );
      expect(body.batch.length).toBe(5);
      expect(pq2.hasDiskData).toBe(false);
    });
  });
});

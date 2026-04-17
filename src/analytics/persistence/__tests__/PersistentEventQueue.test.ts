import { NativeModules } from 'react-native';
import Dispatcher from '../../dispatcher';
import CircuitBreaker from '../../utils/circuitBreaker';

function mockNativeStorage() {
  const store: { data: string | null } = { data: null };
  NativeModules.MetaRouterQueueStorage = {
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
    maxQueueBytes: 5 * 1024 * 1024,
    autoFlushThreshold: 9999,
    maxBatchSize: 100,
    flushIntervalSeconds: 3600,
    baseRetryDelayMs: 1000,
    maxRetryDelayMs: 8000,
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
    const { _resetRehydrationGuard } = require('../PersistentEventQueue');
    _resetRehydrationGuard();
  });

  afterEach(() => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
  });

  describe('rehydrate', () => {
    it('loads events from disk on first call and prepends to queue', async () => {
      const { store } = mockNativeStorage();
      const events = [
        { type: 'track', event: 'disk1', messageId: '1' },
        { type: 'track', event: 'disk2', messageId: '2' },
      ];
      store.data = JSON.stringify({ version: 1, events });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(2);
      expect((dispatcher.getQueueRef()[0] as any).event).toBe('disk1');
    });

    it('does not rehydrate a second time', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'disk1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();
      await pq.rehydrate();

      expect(mock.readSnapshot).toHaveBeenCalledTimes(1);
      expect(dispatcher.getQueueRef().length).toBe(1);
    });

    it('flushes entire queue to disk when rehydrated events exceed memory byte cap', async () => {
      const { store } = mockNativeStorage();
      // Use uniform-size events so byte cap maps to exact count
      const events = Array.from({ length: 2500 }, (_, i) => ({
        type: 'track',
        event: 'evt',
        properties: { id: String(i).padStart(5, '0') },
      }));
      const eventSize = JSON.stringify(events[0]).length;
      store.data = JSON.stringify({ version: 1, events });

      const overflowEvents: any[] = [];
      const dispatcher = createDispatcher({
        maxQueueBytes: eventSize * 2000,
        onCapacityOverflow: (evts: any[]) => {
          overflowEvents.push(...evts);
        },
      });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(0);
      expect(overflowEvents.length).toBe(2500);
    });

    it('skips rehydration if snapshot has unknown version', async () => {
      const { store } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 99,
        events: [{ type: 'track', event: 'x' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(0);
    });

    it('handles corrupt JSON gracefully', async () => {
      const { store } = mockNativeStorage();
      store.data = '{not valid json';

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(0);
    });

    it('handles null snapshot (no file on disk)', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(0);
    });

    it('deletes snapshot after successful rehydration', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'x' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
    });

    it('deletes snapshot when version is unknown', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 99,
        events: [{ type: 'track', event: 'x' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(dispatcher.getQueueRef().length).toBe(0);
    });

    it('deletes snapshot when JSON is corrupt', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = '{not valid json';

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(dispatcher.getQueueRef().length).toBe(0);
    });
  });

  describe('resetRehydrationGuard', () => {
    it('allows rehydration again after reset', async () => {
      const { store, mock } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const {
        PersistentEventQueue,
        _resetRehydrationGuard,
      } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();
      expect(dispatcher.getQueueRef().length).toBe(1);

      _resetRehydrationGuard();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e2' }],
      });

      const pq2 = new PersistentEventQueue(dispatcher);
      await pq2.rehydrate();

      expect(mock.readSnapshot).toHaveBeenCalledTimes(2);
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
      // Memory queue drained
      expect(dispatcher.getQueueRef().length).toBe(0);
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
    it('delegates to native module', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.deleteSnapshot();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
    });
  });

  describe('rehydrate + enqueue ordering', () => {
    it('rehydrated events appear before new events', async () => {
      const { store } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'old1', messageId: '1' },
          { type: 'track', event: 'old2', messageId: '2' },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      dispatcher.enqueue({ type: 'track', event: 'new1' } as any);

      const queue = dispatcher.getQueueRef();
      expect((queue[0] as any).event).toBe('old1');
      expect((queue[1] as any).event).toBe('old2');
      expect((queue[2] as any).event).toBe('new1');
    });
  });

  describe('TTL expiry', () => {
    it('drops events older than 7 days on rehydrate', async () => {
      const { store } = mockNativeStorage();
      const now = Date.now();
      const eightDaysAgo = new Date(
        now - 8 * 24 * 60 * 60 * 1000
      ).toISOString();
      const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'expired', timestamp: eightDaysAgo },
          { type: 'track', event: 'fresh', timestamp: oneDayAgo },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(1);
      expect((dispatcher.getQueueRef()[0] as any).event).toBe('fresh');
    });

    it('keeps events without a timestamp field', async () => {
      const { store } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'no_ts' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(1);
    });

    it('discards snapshot and deletes from disk when all events are expired', async () => {
      const { store, mock } = mockNativeStorage();
      const eightDaysAgo = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000
      ).toISOString();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'old1', timestamp: eightDaysAgo },
          { type: 'track', event: 'old2', timestamp: eightDaysAgo },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(0);
      expect(mock.deleteSnapshot).toHaveBeenCalled();
    });
  });

  describe('sentAt on rehydrated events', () => {
    it('does not set sentAt at rehydration time (drainBatch stamps it at send time)', async () => {
      const { store } = mockNativeStorage();
      const oneDayAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1', timestamp: oneDayAgo }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      const rehydrated = dispatcher.getQueueRef()[0] as any;
      expect(rehydrated.sentAt).toBeUndefined();
      expect(rehydrated.timestamp).toBe(oneDayAgo);
    });
  });

  describe('rehydratedEvents count', () => {
    it('tracks the number of rehydrated events', async () => {
      const { store } = mockNativeStorage();
      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'e1' },
          { type: 'track', event: 'e2' },
          { type: 'track', event: 'e3' },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      expect(pq.rehydratedEvents).toBe(0);
      await pq.rehydrate();
      expect(pq.rehydratedEvents).toBe(3);
    });

    it('excludes expired events from count', async () => {
      const { store } = mockNativeStorage();
      const eightDaysAgo = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000
      ).toISOString();
      const oneDayAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();

      store.data = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'expired', timestamp: eightDaysAgo },
          { type: 'track', event: 'fresh1', timestamp: oneDayAgo },
          { type: 'track', event: 'fresh2', timestamp: oneDayAgo },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();
      expect(pq.rehydratedEvents).toBe(2);
    });

    it('is 0 when no snapshot exists', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();
      expect(pq.rehydratedEvents).toBe(0);
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
      // 4 + 2 = 6, cap = 5, drop 1 oldest
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

    it('deletes disk file after drain', async () => {
      const { store, mock } = mockNativeStorage();

      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(store.data).toBeNull();
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
  });

  describe('full round-trip', () => {
    it('enqueue → flushToDisk → rehydrate preserves events', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const {
        PersistentEventQueue,
        _resetRehydrationGuard,
      } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue({
          type: 'track',
          event: `e${i}`,
          properties: { i },
        } as any);
      }

      await pq.flushToDisk();

      _resetRehydrationGuard();
      const dispatcher2 = createDispatcher();
      const pq2 = new PersistentEventQueue(dispatcher2);

      await pq2.rehydrate();

      expect(dispatcher2.getQueueRef().length).toBe(5);
      expect((dispatcher2.getQueueRef()[0] as any).event).toBe('e0');
      expect((dispatcher2.getQueueRef()[4] as any).event).toBe('e4');
    });

    it('partial drain then flush only persists remaining events', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const {
        PersistentEventQueue,
        _resetRehydrationGuard,
      } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue({
          type: 'track',
          event: `e${i}`,
        } as any);
      }

      await dispatcher.flush();
      expect(dispatcher.getQueueRef().length).toBe(0);

      dispatcher.enqueue({ type: 'track', event: 'late1' } as any);
      dispatcher.enqueue({ type: 'track', event: 'late2' } as any);

      await pq.flushToDisk();

      _resetRehydrationGuard();
      const dispatcher2 = createDispatcher();
      const pq2 = new PersistentEventQueue(dispatcher2);
      await pq2.rehydrate();

      expect(dispatcher2.getQueueRef().length).toBe(2);
      expect((dispatcher2.getQueueRef()[0] as any).event).toBe('late1');
    });
  });
});

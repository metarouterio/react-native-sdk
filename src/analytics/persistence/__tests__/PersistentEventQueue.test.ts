import { NativeModules } from 'react-native';
import Dispatcher from '../../dispatcher';
import CircuitBreaker from '../../utils/circuitBreaker';

// Helpers
function mockNativeStorage() {
  const store: { data: string | null; overflow: string | null } = {
    data: null,
    overflow: null,
  };
  NativeModules.MetaRouterQueueStorage = {
    readSnapshot: jest.fn(async () => store.data),
    writeSnapshot: jest.fn(async (data: string) => {
      store.data = data;
    }),
    deleteSnapshot: jest.fn(async () => {
      store.data = null;
    }),
    readOverflowSnapshot: jest.fn(async () => store.overflow),
    writeOverflowSnapshot: jest.fn(async (data: string) => {
      store.overflow = data;
    }),
    deleteOverflowSnapshot: jest.fn(async () => {
      store.overflow = null;
    }),
  };
  return { store, mock: NativeModules.MetaRouterQueueStorage };
}

function createDispatcher(overrides?: Partial<any>) {
  return new Dispatcher({
    maxQueueBytes: 5 * 1024 * 1024, // 5MB
    autoFlushThreshold: 9999,
    maxBatchSize: 100,
    flushIntervalSeconds: 3600,
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
    // Reset the rehydration guard before each test
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

      // readSnapshot should only be called once
      expect(mock.readSnapshot).toHaveBeenCalledTimes(1);
      expect(dispatcher.getQueueRef().length).toBe(1);
    });

    it('enforces capacity cap on rehydrated events (drops oldest)', async () => {
      const { store } = mockNativeStorage();
      // Use uniform-size events so byte cap maps to exact count
      const events = Array.from({ length: 2500 }, (_, i) => ({
        type: 'track',
        event: 'evt',
        properties: { id: String(i).padStart(5, '0') },
      }));
      const eventSize = JSON.stringify(events[0]).length;
      store.data = JSON.stringify({ version: 1, events });

      const dispatcher = createDispatcher({ maxQueueBytes: eventSize * 2000 });
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.rehydrate();

      expect(dispatcher.getQueueRef().length).toBe(2000);
      // Should keep newest: events 500-2499
      expect((dispatcher.getQueueRef()[0] as any).properties.id).toBe('00500');
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

      // Reset guard and provide new snapshot
      _resetRehydrationGuard();
      store.data = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e2' }],
      });

      const pq2 = new PersistentEventQueue(dispatcher);
      await pq2.rehydrate();

      // Should have rehydrated the second time
      expect(mock.readSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('flushToDisk', () => {
    it('writes current queue state to disk as versioned JSON', async () => {
      const { mock } = mockNativeStorage();

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
      const written = JSON.parse(mock.writeSnapshot.mock.calls[0][0]);
      expect(written.version).toBe(1);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('mem1');
    });

    it('deletes snapshot if queue is empty', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushToDisk();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(mock.writeSnapshot).not.toHaveBeenCalled();
    });

    it('serializes flushToDisk calls (no concurrent writes)', async () => {
      const { mock } = mockNativeStorage();

      let writeResolve: (() => void) | null = null;
      mock.writeSnapshot = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            writeResolve = resolve;
          })
      );

      const dispatcher = createDispatcher();
      dispatcher.enqueue({ type: 'track', event: 'e1' } as any);

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      const p1 = pq.flushToDisk();
      const p2 = pq.flushToDisk();

      // Only one write should be in flight
      expect(mock.writeSnapshot).toHaveBeenCalledTimes(1);

      writeResolve!();
      await p1;
      await p2;
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

  describe('size-based flush threshold', () => {
    it('shouldFlushToDisk returns true when byte size exceeds threshold', () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      // Create a large event (~2KB each, need ~1000 to reach 2MB)
      const bigProps: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        bigProps[`key${i}`] = 'x'.repeat(100);
      }

      // Enqueue enough events to exceed 2MB
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

      // Now enqueue new events
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
      // Original timestamp preserved
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

  describe('handleOverflow', () => {
    it('accumulates events in overflow buffer', () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      pq.handleOverflow([
        { type: 'track', event: 'o1' },
        { type: 'track', event: 'o2' },
      ]);

      expect(pq.overflowBufferCount).toBe(2);
    });

    it('respects maxOfflineDiskEvents cap on buffer', () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher, {
        maxOfflineDiskEvents: 5,
      });

      const events = Array.from({ length: 10 }, (_, i) => ({
        type: 'track',
        event: `e${i}`,
      }));
      pq.handleOverflow(events);

      // Buffer should be capped at 5 (oldest dropped)
      expect(pq.overflowBufferCount).toBe(5);
    });

    it('triggers flush to disk at batch threshold', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      // Overflow exactly 100 events (the OVERFLOW_BATCH_THRESHOLD)
      const events = Array.from({ length: 100 }, (_, i) => ({
        type: 'track',
        event: `e${i}`,
      }));
      pq.handleOverflow(events);

      // Allow async flush to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mock.writeOverflowSnapshot).toHaveBeenCalled();
    });

    it('does not flush to disk below batch threshold', () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      pq.handleOverflow([{ type: 'track', event: 'e1' }]);

      expect(mock.writeOverflowSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('flushOverflowBufferToDisk', () => {
    it('writes buffer contents to overflow disk store', async () => {
      const { store, mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      pq.handleOverflow([
        { type: 'track', event: 'o1' },
        { type: 'track', event: 'o2' },
      ]);

      await pq.flushOverflowBufferToDisk();

      expect(mock.writeOverflowSnapshot).toHaveBeenCalled();
      const written = JSON.parse(store.overflow!);
      expect(written.version).toBe(1);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('o1');

      // Buffer should be emptied
      expect(pq.overflowBufferCount).toBe(0);
    });

    it('merges with existing overflow on disk', async () => {
      const { store } = mockNativeStorage();

      // Pre-populate overflow on disk
      store.overflow = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'existing1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      pq.handleOverflow([{ type: 'track', event: 'new1' }]);
      await pq.flushOverflowBufferToDisk();

      const written = JSON.parse(store.overflow!);
      expect(written.events.length).toBe(2);
      expect(written.events[0].event).toBe('existing1');
      expect(written.events[1].event).toBe('new1');
    });

    it('enforces disk cap when merging', async () => {
      const { store } = mockNativeStorage();

      // Pre-populate with 4 events on disk
      store.overflow = JSON.stringify({
        version: 1,
        events: Array.from({ length: 4 }, (_, i) => ({
          type: 'track',
          event: `old${i}`,
        })),
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher, {
        maxOfflineDiskEvents: 5,
      });

      pq.handleOverflow([
        { type: 'track', event: 'new1' },
        { type: 'track', event: 'new2' },
      ]);
      await pq.flushOverflowBufferToDisk();

      const written = JSON.parse(store.overflow!);
      // 4 + 2 = 6, cap = 5, drop 1 oldest
      expect(written.events.length).toBe(5);
      // oldest (old0) should be dropped
      expect(written.events[0].event).toBe('old1');
    });

    it('is a no-op when buffer is empty', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.flushOverflowBufferToDisk();

      expect(mock.writeOverflowSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('drainDiskToNetwork', () => {
    it('sends overflow events directly to network without entering memory queue', async () => {
      const { store } = mockNativeStorage();

      store.overflow = JSON.stringify({
        version: 1,
        events: [
          { type: 'track', event: 'overflow1' },
          { type: 'track', event: 'overflow2' },
        ],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      // Events sent via sendBatchDirect (fetchWithTimeout)
      expect(dispatcher.getQueueRef().length).toBe(0); // memory queue untouched
      expect((dispatcher as any).opts.fetchWithTimeout).toHaveBeenCalled();
    });

    it('deletes overflow file after drain', async () => {
      const { store, mock } = mockNativeStorage();

      store.overflow = JSON.stringify({
        version: 1,
        events: [{ type: 'track', event: 'e1' }],
      });

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect(mock.deleteOverflowSnapshot).toHaveBeenCalled();
      expect(store.overflow).toBeNull();
    });

    it('stops on network failure', async () => {
      const { store } = mockNativeStorage();

      store.overflow = JSON.stringify({
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

      // Events should still be on disk
      expect(store.overflow).not.toBeNull();
      const remaining = JSON.parse(store.overflow!);
      expect(remaining.events.length).toBe(5);
    });

    it('drains in batches of 100', async () => {
      const { store } = mockNativeStorage();

      store.overflow = JSON.stringify({
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

      // Should have sent 3 batches: 100 + 100 + 50
      expect(fetchCalls).toEqual([100, 100, 50]);
      expect(store.overflow).toBeNull();
    });

    it('is a no-op when no overflow file exists', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      await pq.drainDiskToNetwork(dispatcher);

      expect((dispatcher as any).opts.fetchWithTimeout).not.toHaveBeenCalled();
    });

    it('filters expired events during drain', async () => {
      const { store: overflowStore } = mockNativeStorage();

      const eightDaysAgo = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000
      ).toISOString();
      const oneDayAgo = new Date(
        Date.now() - 1 * 24 * 60 * 60 * 1000
      ).toISOString();

      overflowStore.overflow = JSON.stringify({
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

    it('flushes overflow buffer before draining', async () => {
      mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      // Add events to buffer (below batch threshold — won't auto-flush)
      pq.handleOverflow([
        { type: 'track', event: 'buffered1' },
        { type: 'track', event: 'buffered2' },
      ]);

      let sentBatch: any[] = [];
      // Override fetch to capture sent events
      (dispatcher as any).opts.fetchWithTimeout = jest.fn(
        async (_url?: string, init?: any) => {
          sentBatch.push(...JSON.parse(init.body).batch);
          return { ok: true, status: 200 } as any;
        }
      );

      await pq.drainDiskToNetwork(dispatcher);

      // Buffered events should have been flushed to disk and then drained
      expect(sentBatch.length).toBe(2);
      expect(sentBatch[0].event).toBe('buffered1');
    });
  });

  describe('flushToDisk with overflow', () => {
    it('flushes overflow buffer to disk alongside queue snapshot', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      dispatcher.enqueue({ type: 'track', event: 'mem1' } as any);

      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      // Add overflow events to buffer
      pq.handleOverflow([{ type: 'track', event: 'overflow1' }]);

      await pq.flushToDisk();

      // Both queue snapshot and overflow should be written
      expect(mock.writeSnapshot).toHaveBeenCalled();
      expect(mock.writeOverflowSnapshot).toHaveBeenCalled();
    });
  });

  describe('deleteSnapshot with overflow', () => {
    it('deletes both queue and overflow snapshots', async () => {
      const { mock } = mockNativeStorage();

      const dispatcher = createDispatcher();
      const { PersistentEventQueue } = require('../PersistentEventQueue');
      const pq = new PersistentEventQueue(dispatcher);

      pq.handleOverflow([{ type: 'track', event: 'o1' }]);

      await pq.deleteSnapshot();

      expect(mock.deleteSnapshot).toHaveBeenCalled();
      expect(mock.deleteOverflowSnapshot).toHaveBeenCalled();
      expect(pq.overflowBufferCount).toBe(0);
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

      // Enqueue events
      for (let i = 0; i < 5; i++) {
        dispatcher.enqueue({
          type: 'track',
          event: `e${i}`,
          properties: { i },
        } as any);
      }

      // Flush to disk
      await pq.flushToDisk();

      // Simulate process restart: new dispatcher, reset guard
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

      // Flush network drains events
      await dispatcher.flush();
      // Queue should be empty after successful network flush
      expect(dispatcher.getQueueRef().length).toBe(0);

      // Add 2 more events
      dispatcher.enqueue({ type: 'track', event: 'late1' } as any);
      dispatcher.enqueue({ type: 'track', event: 'late2' } as any);

      // Flush to disk
      await pq.flushToDisk();

      // Simulate restart
      _resetRehydrationGuard();
      const dispatcher2 = createDispatcher();
      const pq2 = new PersistentEventQueue(dispatcher2);
      await pq2.rehydrate();

      // Should only have the 2 late events
      expect(dispatcher2.getQueueRef().length).toBe(2);
      expect((dispatcher2.getQueueRef()[0] as any).event).toBe('late1');
    });
  });
});

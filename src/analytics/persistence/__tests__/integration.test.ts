import { NativeModules, AppState } from 'react-native';
import { _resetRehydrationGuard } from '../PersistentEventQueue';

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

describe('MetaRouterAnalyticsClient + persistence integration', () => {
  let handleAppStateChange: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRehydrationGuard();
    handleAppStateChange = null;

    // Mock fetch so flush() doesn't hang on a real network call
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as Response)
    );

    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_type: string, handler: (state: string) => void) => {
        handleAppStateChange = handler;
        return { remove: jest.fn() };
      }
    );
  });

  afterEach(() => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
    (global.fetch as jest.Mock).mockRestore?.();
  });

  it('rehydrates events from disk during init', async () => {
    const { store } = mockNativeStorage();
    store.data = JSON.stringify({
      version: 1,
      events: [
        {
          type: 'track',
          event: 'persisted',
          messageId: 'abc',
          anonymousId: 'anon1',
          context: {},
          writeKey: 'k',
        },
      ],
    });

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const client = new MetaRouterAnalyticsClient({
      writeKey: 'test-key',
      ingestionHost: 'https://example.com',
    });
    await client.init();

    // Rehydrated events should have been flushed immediately on init
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'persisted', messageId: 'abc' }),
      ])
    );
  });

  it('flushes to disk when app goes to background and network fails', async () => {
    const { mock } = mockNativeStorage();

    // Simulate network failure so events remain in queue for persistence
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.reject(new Error('Network unavailable'))
    );

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const client = new MetaRouterAnalyticsClient({
      writeKey: 'test-key',
      ingestionHost: 'https://example.com',
    });
    await client.init();

    // Track some events
    client.track('event1', { key: 'value' });
    client.track('event2', { key: 'value' });

    // Simulate app going to background — flush fails, events persisted to disk
    await handleAppStateChange!('background');

    expect(mock.writeSnapshot).toHaveBeenCalled();
  });

  it('leaves disk untouched when network flush succeeds on background with empty memory', async () => {
    const { mock } = mockNativeStorage();

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const client = new MetaRouterAnalyticsClient({
      writeKey: 'test-key',
      ingestionHost: 'https://example.com',
    });
    await client.init();

    // Track some events
    client.track('event1', { key: 'value' });
    client.track('event2', { key: 'value' });

    // Simulate app going to background — flush succeeds, queue empty, no disk write
    await handleAppStateChange!('background');

    // Queue was drained by network flush — post-consolidation, flushToDisk is
    // a no-op when memory is empty (doesn't touch disk state).
    expect(mock.writeSnapshot).not.toHaveBeenCalled();
    expect(mock.deleteSnapshot).not.toHaveBeenCalled();
  });

  it('deletes snapshot on reset', async () => {
    const { mock } = mockNativeStorage();

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const client = new MetaRouterAnalyticsClient({
      writeKey: 'test-key',
      ingestionHost: 'https://example.com',
    });
    await client.init();

    await client.reset();

    expect(mock.deleteSnapshot).toHaveBeenCalled();
  });

  it('capacity overflow writes events to disk', async () => {
    const { mock } = mockNativeStorage();

    // Network fails so events stay in queue
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.reject(new Error('Network unavailable'))
    );

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const { StubNetworkMonitor } = require('../../utils/networkMonitor');
    const monitor = new StubNetworkMonitor('disconnected');

    const client = new MetaRouterAnalyticsClient(
      {
        writeKey: 'test-key',
        ingestionHost: 'https://example.com',
        // Small queue so we can trigger overflow easily
        maxQueueBytes: 500,
        maxOfflineDiskEvents: 100,
      },
      { networkMonitor: monitor }
    );
    await client.init();

    // Track many events to overflow memory queue
    for (let i = 0; i < 50; i++) {
      client.track(`event_${i}`, { idx: i });
    }

    // Allow async overflow writes to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Overflow should have been written to the single disk file
    expect(mock.writeSnapshot).toHaveBeenCalled();
  });

  it('events enqueue successfully while offline (no errors, no HTTP attempts)', async () => {
    mockNativeStorage();

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const { StubNetworkMonitor } = require('../../utils/networkMonitor');
    const monitor = new StubNetworkMonitor('disconnected');

    const client = new MetaRouterAnalyticsClient(
      {
        writeKey: 'test-key',
        ingestionHost: 'https://example.com',
      },
      { networkMonitor: monitor }
    );
    await client.init();

    // Track events while offline
    client.track('offline_event_1');
    client.track('offline_event_2');

    // Flush should not make any HTTP calls (events go to disk)
    await client.flush();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('offline flush sends events to disk, online drains them', async () => {
    const { mock } = mockNativeStorage();

    const {
      MetaRouterAnalyticsClient,
    } = require('../../MetaRouterAnalyticsClient');
    const { StubNetworkMonitor } = require('../../utils/networkMonitor');
    const monitor = new StubNetworkMonitor('disconnected');

    const client = new MetaRouterAnalyticsClient(
      {
        writeKey: 'test-key',
        ingestionHost: 'https://example.com',
      },
      { networkMonitor: monitor }
    );
    await client.init();

    // Track events while offline
    client.track('offline_1');
    client.track('offline_2');

    // Flush while offline — events should go to disk
    await client.flush();

    // Allow async disk writes to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mock.writeSnapshot).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    // Go online — should drain disk to network
    monitor.simulate('connected');

    // Allow drain to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(global.fetch).toHaveBeenCalled();
  });
});

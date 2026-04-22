import { NativeModules, AppState } from 'react-native';

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

describe('MetaRouterAnalyticsClient + persistence integration', () => {
  let handleAppStateChange: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('drains on-disk events directly to network during init (no memory rehydrate)', async () => {
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

    // Allow async drain to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Disk events should have been sent via drainDiskToNetwork → fetch
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'persisted', messageId: 'abc' }),
      ])
    );
  });

  it('does not load disk events into the memory queue on init (cheap exists-only check)', async () => {
    const { store, mock } = mockNativeStorage();
    store.data = JSON.stringify({
      version: 1,
      events: [{ type: 'track', event: 'persisted' }],
    });

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

    // Offline, so no drain runs. readSnapshot should not have fired.
    expect(mock.exists).toHaveBeenCalled();
    expect(mock.readSnapshot).not.toHaveBeenCalled();
    // Memory queue remains empty — disk events will drain when online.
    const debug = await client.getDebugInfo();
    expect(debug.queueLength).toBe(0);
    expect(debug.hasDiskData).toBe(true);
  });

  it('flushes to disk when app goes to background and network fails', async () => {
    const { mock } = mockNativeStorage();

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

    client.track('event1', { key: 'value' });
    client.track('event2', { key: 'value' });

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

    client.track('event1', { key: 'value' });
    client.track('event2', { key: 'value' });

    await handleAppStateChange!('background');

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
        maxQueueEvents: 10,
        maxDiskEvents: 100,
      },
      { networkMonitor: monitor }
    );
    await client.init();

    for (let i = 0; i < 50; i++) {
      client.track(`event_${i}`, { idx: i });
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

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

    client.track('offline_event_1');
    client.track('offline_event_2');

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

    client.track('offline_1');
    client.track('offline_2');

    await client.flush();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mock.writeSnapshot).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();

    monitor.simulate('connected');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(global.fetch).toHaveBeenCalled();
  });
});

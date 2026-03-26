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

    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_type: string, handler: (state: string) => void) => {
        handleAppStateChange = handler;
        return { remove: jest.fn() };
      }
    );
  });

  afterEach(() => {
    NativeModules.MetaRouterQueueStorage = undefined as any;
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

    const info = await client.getDebugInfo();
    // Should have the rehydrated event
    expect(info.queueLength).toBeGreaterThanOrEqual(1);
  });

  it('flushes to disk when app goes to background', async () => {
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

    // Simulate app going to background
    handleAppStateChange!('background');

    // Allow async flush to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(mock.writeSnapshot).toHaveBeenCalled();
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
});

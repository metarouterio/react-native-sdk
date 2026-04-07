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

  it('skips disk write when network flush succeeds on background', async () => {
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

    // Simulate app going to background — flush succeeds, queue empty
    await handleAppStateChange!('background');

    // Queue was drained by network flush, so deleteSnapshot is called (empty queue)
    expect(mock.writeSnapshot).not.toHaveBeenCalled();
    expect(mock.deleteSnapshot).toHaveBeenCalled();
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

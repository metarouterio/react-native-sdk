import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient';
import { SessionManager } from './session/sessionManager';
import type { StoredSession } from './utils/sessionStorage';
import type { InitOptions } from './types';
import { AppState } from 'react-native';

jest.spyOn(AppState, 'addEventListener').mockImplementation(jest.fn());

jest.mock('./utils/identityStorage', () => ({
  getIdentityField: jest.fn(async (key: string) =>
    key === 'metarouter:anonymous_id' ? 'anon-123' : undefined
  ),
  setIdentityField: jest.fn(() => Promise.resolve()),
  removeIdentityField: jest.fn(() => Promise.resolve()),
  ANONYMOUS_ID_KEY: 'metarouter:anonymous_id',
  USER_ID_KEY: 'metarouter:user_id',
  GROUP_ID_KEY: 'metarouter:group_id',
  ADVERTISING_ID_KEY: 'metarouter:advertising_id',
}));

jest.mock('./utils/lifecycleStorage', () => ({
  getLifecycleVersion: jest.fn(() => Promise.resolve(null)),
  getLifecycleBuild: jest.fn(() => Promise.resolve(null)),
  setLifecycleVersionBuild: jest.fn(() => Promise.resolve()),
}));

const WALL_START = 1_757_400_000_000;
const MINUTE = 60_000;

const opts: InitOptions = {
  ingestionHost: 'https://example.com',
  writeKey: 'test_write_key',
  trackLifecycleEvents: false,
};

describe('session tracking', () => {
  let wallNow: number;
  let monoNow: number;
  let stored: StoredSession;

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
    wallNow = WALL_START;
    monoNow = 0;
    stored = { id: null, count: null, lastActivityMs: null };
  });

  function makeClient(options: Partial<InitOptions> = {}, timeout = 30) {
    const sessionManager = new SessionManager(timeout, {
      load: async () => ({ ...stored }),
      saveSession: jest.fn(),
      saveLastActivity: jest.fn(),
      wallClockMs: () => wallNow,
      monotonicClockMs: () => monoNow,
    });
    return new MetaRouterAnalyticsClient(
      { ...opts, ...options },
      { sessionManager }
    ) as MetaRouterAnalyticsClient & { queue: any[] };
  }

  const advance = (ms: number) => {
    wallNow += ms;
    monoNow += ms;
  };

  // Session Started is enqueued from a microtask after the minting event.
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const names = (client: { queue: any[] }) => client.queue.map((e) => e.event);

  it('stamps every event with the session at context.providers.metarouter', async () => {
    const client = makeClient();
    await client.init();

    client.track('A');
    client.screen('Home');
    client.identify('user-1');

    expect(client.queue).toHaveLength(3);
    for (const event of client.queue) {
      expect(event.context.providers).toEqual({
        metarouter: { sessionID: String(WALL_START), sessionCount: 1 },
      });
    }
  });

  it('does not write the stamp into the shared cached context', async () => {
    const client = makeClient();
    await client.init();

    client.track('A');

    expect((client as any).context.providers).toBeUndefined();
  });

  it('fires Session Started once, after the event that minted the session', async () => {
    const client = makeClient({ fireSessionStarted: true });
    await client.init();

    client.track('A');
    client.track('B');
    await settle();

    expect(names(client)).toEqual(['A', 'B', 'Session Started']);
    const started = client.queue[2];
    expect(started.type).toBe('track');
    expect(started.properties).toBeUndefined();
    expect(started.context.providers.metarouter.sessionID).toBe(
      String(WALL_START)
    );
  });

  it('fires Session Started for the new session on rollover', async () => {
    const client = makeClient({ fireSessionStarted: true });
    await client.init();
    client.track('A');
    await settle();

    advance(31 * MINUTE);
    client.track('B');
    await settle();

    expect(names(client)).toEqual([
      'A',
      'Session Started',
      'B',
      'Session Started',
    ]);
    expect(client.queue[3].context.providers.metarouter).toEqual({
      sessionID: String(wallNow),
      sessionCount: 2,
    });
  });

  it('emits no Session Started when the flag is off', async () => {
    const client = makeClient();
    await client.init();

    client.track('A');
    await settle();

    expect(names(client)).toEqual(['A']);
  });

  it('resumes the persisted session loaded during init', async () => {
    stored = { id: '1757399000000', count: 4, lastActivityMs: WALL_START };
    wallNow = WALL_START + 10 * MINUTE;
    const client = makeClient({ fireSessionStarted: true });
    await client.init();

    client.track('A');
    await settle();

    expect(names(client)).toEqual(['A']);
    expect(client.queue[0].context.providers.metarouter).toEqual({
      sessionID: '1757399000000',
      sessionCount: 4,
    });
  });

  it('getSessionId is null before the first event, then matches the stamp', async () => {
    const client = makeClient();
    await client.init();

    await expect(client.getSessionId()).resolves.toBeNull();
    const before = await client.getDebugInfo();
    expect(before).not.toHaveProperty('sessionId');

    client.track('A');

    await expect(client.getSessionId()).resolves.toBe(String(WALL_START));
    expect(await client.getDebugInfo()).toMatchObject({
      sessionId: String(WALL_START),
      sessionCount: 1,
    });
  });

  it('getSessionId survives reset', async () => {
    const client = makeClient();
    await client.init();
    client.track('A');

    await client.reset();

    await expect(client.getSessionId()).resolves.toBe(String(WALL_START));
  });

  it('stamps lifecycle events and counts them as activity', async () => {
    const client = makeClient({
      trackLifecycleEvents: true,
      fireSessionStarted: true,
    });
    await client.init();
    await settle();

    const lifecycle = client.queue.filter((e) =>
      String(e.event).startsWith('Application')
    );
    expect(lifecycle.length).toBeGreaterThan(0);
    for (const event of client.queue) {
      expect(event.context.providers.metarouter.sessionID).toBe(
        String(WALL_START)
      );
    }
    expect(names(client).filter((n) => n === 'Session Started')).toHaveLength(
      1
    );
  });

  it('applies sessionTimeoutMinutes from InitOptions', async () => {
    // No injected manager: the client builds one from the options. The
    // jest-mocked native clock and the wall clock both follow Date.now.
    jest.setSystemTime(WALL_START);
    const client = new MetaRouterAnalyticsClient({
      ...opts,
      sessionTimeoutMinutes: 1,
    }) as MetaRouterAnalyticsClient & { queue: any[] };
    await client.init();
    client.track('A');

    jest.setSystemTime(WALL_START + MINUTE + 1);
    client.track('B');

    const [a, b] = client.queue.map((e) => e.context.providers.metarouter);
    expect(a.sessionID).toBe(String(WALL_START));
    expect(b.sessionID).toBe(String(WALL_START + MINUTE + 1));
  });
});

describe('session tracking through the public API', () => {
  it('survives reset(): the next client resumes the same session', async () => {
    // reset() tears the client down and createAnalyticsClient builds a new
    // one, so continuity runs through storage — backed by a real map here.
    const store = new Map<string, string>();
    const AsyncStorage =
      require('@react-native-async-storage/async-storage').default;
    AsyncStorage.multiGet.mockImplementation(async (keys: string[]) =>
      keys.map((k) => [k, store.get(k) ?? null])
    );
    AsyncStorage.multiSet.mockImplementation(async (pairs: string[][]) => {
      for (const [k, v] of pairs) store.set(k!, v!);
    });
    AsyncStorage.setItem.mockImplementation(async (k: string, v: string) => {
      store.set(k, v);
    });

    let createAnalyticsClient!: typeof import('./init').createAnalyticsClient;
    jest.isolateModules(() => {
      createAnalyticsClient = require('./init').createAnalyticsClient;
    });
    jest.setSystemTime(WALL_START);

    const first = createAnalyticsClient(opts);
    await first.getAnonymousId(); // resolves once bound
    first.track('Before logout');
    const sessionId = await first.getSessionId();
    expect(sessionId).toBe(String(WALL_START));

    // Inside the 5 s throttle: only reset()'s own write keeps this exact.
    jest.setSystemTime(WALL_START + 3_000);
    first.track('Logout');
    await first.reset();
    // Written by reset() itself, before any new client touches the session.
    expect(store.get('metarouter:session:last_activity_ms')).toBe(
      String(WALL_START + 3_000)
    );

    const second = createAnalyticsClient(opts);
    await second.getAnonymousId();
    await expect(second.getSessionId()).resolves.toBeNull(); // no event yet
    second.track('After logout');

    await expect(second.getSessionId()).resolves.toBe(sessionId);
    await second.reset();
  });
});

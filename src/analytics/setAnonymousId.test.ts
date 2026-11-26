/**
 * setAnonymousId end to end: the public proxy and init.ts routing, the real
 * IdentityManager, identity and lifecycle storage over a Map-backed
 * AsyncStorage. Each test loads fresh modules, so init.ts state starts clean.
 */

type Loaded = {
  createAnalyticsClient: typeof import('./init').createAnalyticsClient;
  init: typeof import('./init');
  proxy: typeof import('./proxy/proxyClient').proxyClient;
  clients: any[];
  // Number of upcoming anonymousId reads that throw.
  failAnonReads: (n: number) => void;
};

const ANON = 'metarouter:anonymous_id';
const opts = {
  ingestionHost: 'https://example.com',
  writeKey: 'k',
  trackLifecycleEvents: true,
};

let store: Map<string, string>;
let writes: [string, string][];

// Real timers: the out-of-order runs use random storage delays, which the
// repo's fake timers would only advance in 20 ms steps.
beforeAll(() => jest.useRealTimers());

// Every client built in a test, stopped afterwards so its real-timer flush
// loop doesn't keep Jest running.
const built: any[] = [];
afterEach(async () => {
  for (const client of built.splice(0)) await client.reset().catch(() => {});
});

// `outOfOrder`: each storage call completes after a random delay, so calls
// can finish in any order — Android's opt-in "next" AsyncStorage storage runs
// each call in its own coroutine.
// `onGet`: called on every storage read, before it resolves — lets a test act
// at the exact moment a given key is read.
function load({
  outOfOrder = false,
  onGet,
}: { outOfOrder?: boolean; onGet?: (key: string) => void } = {}): Loaded {
  let loaded!: Loaded;
  jest.isolateModules(() => {
    const AsyncStorage =
      require('@react-native-async-storage/async-storage').default;
    let failing = 0;
    const lag = () =>
      outOfOrder
        ? new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)))
        : Promise.resolve();
    AsyncStorage.getItem.mockImplementation(async (k: string) => {
      onGet?.(k);
      await lag();
      if (k === ANON && failing > 0) {
        failing--;
        throw new Error('simulated: database is locked');
      }
      return store.get(k) ?? null;
    });
    AsyncStorage.setItem.mockImplementation(async (k: string, v: string) => {
      await lag();
      writes.push([k, v]);
      store.set(k, v);
    });
    AsyncStorage.removeItem.mockImplementation(async (k: string) => {
      await lag();
      store.delete(k);
    });
    const {
      MetaRouterAnalyticsClient,
    } = require('./MetaRouterAnalyticsClient');
    const clients: any[] = [];
    const init = MetaRouterAnalyticsClient.prototype.init;
    jest
      .spyOn(MetaRouterAnalyticsClient.prototype, 'init')
      .mockImplementation(function (this: any) {
        clients.push(this);
        built.push(this);
        return init.call(this);
      });
    loaded = {
      createAnalyticsClient: require('./init').createAnalyticsClient,
      init: require('./init'),
      proxy: require('./proxy/proxyClient').proxyClient,
      clients,
      failAnonReads: (n) => {
        failing = n;
      },
    };
  });
  return loaded;
}

const events = (client: any) =>
  client.queue.map((e: any) => ({
    event: e.event ?? e.type,
    id: e.anonymousId,
  }));

// Lets fire-and-forget storage writes land (out-of-order runs lag up to 3 ms
// per call).
const settle = () => new Promise((r) => setTimeout(r, 60));
const USER = 'metarouter:user_id';
const waitFor = async (cond: () => unknown) => {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};
const MARKER = 'metarouter:anonymous_id_host_set';

beforeEach(() => {
  store = new Map();
  writes = [];
  (global as any).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 200 });
});

describe('setAnonymousId', () => {
  describe('validation', () => {
    it('trims, and rejects empty, non-string and over-256-byte values with the id unchanged', async () => {
      const { createAnalyticsClient, proxy } = load();
      const analytics = createAnalyticsClient(opts);
      const before = await analytics.getAnonymousId();

      expect(proxy.setAnonymousId('')).toBe(false);
      expect(proxy.setAnonymousId('   ')).toBe(false);
      expect(proxy.setAnonymousId(undefined as any)).toBe(false);
      // 129 two-byte characters: 258 UTF-8 bytes, though only 129 chars.
      expect(proxy.setAnonymousId('é'.repeat(129))).toBe(false);
      expect(await analytics.getAnonymousId()).toBe(before);

      expect(proxy.setAnonymousId('é'.repeat(128))).toBe(true);
      expect(proxy.setAnonymousId('  web-id  ')).toBe(true);
      expect(await analytics.getAnonymousId()).toBe('web-id');
      // The current value again: accepted, nothing changes.
      expect(proxy.setAnonymousId('web-id')).toBe(true);
      expect(await analytics.getAnonymousId()).toBe('web-id');
    });
  });

  describe('before createAnalyticsClient', () => {
    it('fresh install: the cold-launch events carry it and still report Application Installed', async () => {
      const { createAnalyticsClient, proxy, clients } = load();

      expect(proxy.setAnonymousId('web-1')).toBe(true);
      const analytics = createAnalyticsClient(opts);
      expect(await analytics.getAnonymousId()).toBe('web-1');

      expect(events(clients[0])).toEqual([
        { event: 'Application Installed', id: 'web-1' },
        { event: 'Application Opened', id: 'web-1' },
      ]);
      await settle();
      expect(store.get(ANON)).toBe('web-1');
    });

    it('existing install: replaces the stored id, which the next launch keeps', async () => {
      const first = load();
      const a1 = first.createAnalyticsClient(opts);
      const generated = await a1.getAnonymousId();
      await settle();

      const second = load(); // next launch
      second.proxy.setAnonymousId('web-2');
      const a2 = second.createAnalyticsClient(opts);
      expect(await a2.getAnonymousId()).toBe('web-2');
      expect(events(second.clients[0])).toEqual([
        { event: 'Application Opened', id: 'web-2' },
      ]);
      await settle();
      expect(store.get(ANON)).toBe('web-2');
      expect(generated).not.toBe('web-2');

      const third = load(); // a launch that doesn't call setAnonymousId
      expect(await third.createAnalyticsClient(opts).getAnonymousId()).toBe(
        'web-2'
      );
    });

    it('set while init is running reaches the cold-launch events', async () => {
      const { createAnalyticsClient, proxy, clients } = load();
      const analytics = createAnalyticsClient(opts);
      expect(proxy.setAnonymousId('web-during-init')).toBe(true);

      expect(await analytics.getAnonymousId()).toBe('web-during-init');
      expect(events(clients[0]).map((e: any) => e.id)).toEqual([
        'web-during-init',
        'web-during-init',
      ]);
    });
  });

  describe('after the bind', () => {
    it('applies to the next event, native and bridge; earlier events keep the old id', async () => {
      const { createAnalyticsClient, proxy, clients } = load();
      const analytics = createAnalyticsClient(opts);
      const old = await analytics.getAnonymousId();
      const client = clients[0];

      analytics.track('Before');
      expect(analytics.setAnonymousId('web-3')).toBe(true);
      analytics.track('After');
      client.enqueueBridgeEvent({ type: 'track', name: 'Web', properties: {} });

      const ids = events(client).slice(-3);
      expect(ids).toEqual([
        { event: 'Before', id: old },
        { event: 'After', id: 'web-3' },
        { event: 'Web', id: 'web-3' },
      ]);
      expect(proxy).toBe(analytics);
      await settle();
      expect(store.get(ANON)).toBe('web-3');
    });
  });

  describe('reset()', () => {
    it('reset() then setAnonymousId: the next client adopts the id instead of generating one', async () => {
      const { createAnalyticsClient, proxy, clients } = load();
      const analytics = createAnalyticsClient(opts);
      await analytics.getAnonymousId();

      const reset = analytics.reset(); // not awaited: a logout's next line
      expect(proxy.setAnonymousId('web-after-reset')).toBe(true);
      await reset;
      await settle();

      const next = createAnalyticsClient(opts);
      expect(await next.getAnonymousId()).toBe('web-after-reset');
      expect(events(clients[1])[0].id).toBe('web-after-reset');
      await settle();
      expect(store.get(ANON)).toBe('web-after-reset');
    });

    it('setAnonymousId then reset(): the id is discarded and a new one is generated', async () => {
      const { createAnalyticsClient, proxy } = load();
      const analytics = createAnalyticsClient(opts);
      await analytics.getAnonymousId();

      proxy.setAnonymousId('web-before-reset');
      await analytics.reset();
      const next = createAnalyticsClient(opts);
      const id = await next.getAnonymousId();
      expect(id).not.toBe('web-before-reset');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('a pre-init id is discarded by a reset() before any createAnalyticsClient', async () => {
      const { createAnalyticsClient, proxy } = load();
      proxy.setAnonymousId('web-pre');
      await proxy.reset();
      expect(await createAnalyticsClient(opts).getAnonymousId()).not.toBe(
        'web-pre'
      );
    });
  });

  it('an id set while the session is refused is adopted when a valid config recovers it', async () => {
    const { createAnalyticsClient, proxy, init } = load();
    const isDev = jest
      .spyOn(init.buildConfig, 'isDevelopmentBuild')
      .mockReturnValue(false);
    try {
      createAnalyticsClient({ ...opts, writeKey: '' });
      expect(proxy.setAnonymousId('web-refused')).toBe(true);
      const analytics = createAnalyticsClient(opts);
      expect(await analytics.getAnonymousId()).toBe('web-refused');
    } finally {
      isDev.mockRestore();
    }
  });

  describe('an id set with no client running survives the app dying before init', () => {
    it('set before createAnalyticsClient: the next launch adopts it', async () => {
      const first = load();
      first.proxy.setAnonymousId('web-early');
      await settle(); // the app dies here, before any createAnalyticsClient

      const next = load();
      expect(await next.createAnalyticsClient(opts).getAnonymousId()).toBe(
        'web-early'
      );
      // Still a fresh install: the pending id is not identity state.
      expect(events(next.clients[0])[0].event).toBe('Application Installed');
    });

    it('reset() then set: the next launch adopts it', async () => {
      const first = load();
      const a = first.createAnalyticsClient(opts);
      await a.getAnonymousId();
      await a.reset();
      first.proxy.setAnonymousId('web-logout');
      await settle(); // dies before re-initializing

      const next = load();
      expect(await next.createAnalyticsClient(opts).getAnonymousId()).toBe(
        'web-logout'
      );
    });

    it('set then reset() before init: the next launch does not adopt it', async () => {
      const first = load();
      first.proxy.setAnonymousId('web-discarded');
      await first.proxy.reset();
      await settle();

      const next = load();
      expect(await next.createAnalyticsClient(opts).getAnonymousId()).not.toBe(
        'web-discarded'
      );
    });
  });

  it('keeps U+FEFF, as the iOS and Android SDKs do, and trims other whitespace', async () => {
    const { createAnalyticsClient, proxy } = load();
    const analytics = createAnalyticsClient(opts);
    await analytics.getAnonymousId();

    expect(proxy.setAnonymousId('\uFEFFweb-bom \n')).toBe(true);
    expect(await analytics.getAnonymousId()).toBe('\uFEFFweb-bom');
  });

  it('install detection that cannot read identity storage reports an upgrade, not a new install', async () => {
    // A user upgrading from a build without lifecycle events: an id is stored,
    // no app version is.
    store.set(ANON, 'stored-id');
    const { createAnalyticsClient, clients, failAnonReads } = load();
    failAnonReads(3); // every attempt of the install check's read
    await createAnalyticsClient(opts).getAnonymousId();

    expect(events(clients[0])[0].event).toBe('Application Updated');
  });

  describe('storage calls that complete out of order', () => {
    it('reset() then set, and set then reset(), land in call order (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        store = new Map([[ANON, 'old']]);
        const { proxy } = load({ outOfOrder: true });
        await proxy.reset();
        proxy.setAnonymousId('kept');
        await settle();
        expect(store.get(ANON)).toBe('kept');

        proxy.setAnonymousId('discarded');
        void proxy.reset();
        await settle();
        expect(store.has(ANON)).toBe(false);
      }
    });

    it('a host id set during init wins over the id init generates (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        store = new Map();
        const { createAnalyticsClient, proxy } = load({ outOfOrder: true });
        const analytics = createAnalyticsClient(opts);
        await Promise.resolve(); // init has started
        proxy.setAnonymousId('web-race');
        expect(await analytics.getAnonymousId()).toBe('web-race');
        await settle();
        expect(store.get(ANON)).toBe('web-race');
      }
    });
  });

  it('reset() with no client running clears identity stored by an earlier launch', async () => {
    const first = load();
    const a = first.createAnalyticsClient(opts);
    a.identify('user-1');
    first.proxy.setAnonymousId('web-A');
    await a.getAnonymousId();
    await settle();

    const next = load(); // next launch: reset() before createAnalyticsClient
    await next.proxy.reset();
    await settle();
    expect(store.has(ANON)).toBe(false);
    expect(store.has(USER)).toBe(false);
    expect(await next.createAnalyticsClient(opts).getAnonymousId()).not.toBe(
      'web-A'
    );
  });

  it('a refused config over a running session clears stored identity, as on Android; one with no session leaves it', async () => {
    store.set(ANON, 'stored-id');
    const { createAnalyticsClient, proxy, init } = load();
    const isDev = jest
      .spyOn(init.buildConfig, 'isDevelopmentBuild')
      .mockReturnValue(false);
    try {
      // No session yet: identity stays.
      createAnalyticsClient({ ...opts, writeKey: '' });
      await settle();
      expect(store.get(ANON)).toBe('stored-id');

      const a = createAnalyticsClient(opts);
      a.identify('user-1');
      proxy.setAnonymousId('web-A');
      await a.getAnonymousId();
      createAnalyticsClient({ ...opts, writeKey: '' }); // over a running session
      proxy.setAnonymousId('web-after-refusal'); // kept: set after the refusal
      await settle();
      expect(store.has(USER)).toBe(false);
      expect(store.get(ANON)).toBe('web-after-refusal');
      expect(await createAnalyticsClient(opts).getAnonymousId()).toBe(
        'web-after-refusal'
      );
    } finally {
      isDev.mockRestore();
    }
  });

  it("an identify() reaching the client being torn down after reset() doesn't reach the next session", async () => {
    const { createAnalyticsClient, proxy } = load();
    const a = createAnalyticsClient(opts);
    await a.getAnonymousId();

    void proxy.reset();
    proxy.identify('late-user'); // still bound to the old client
    await settle();
    expect(store.has(USER)).toBe(false);
  });

  it('the install marker is set only on a device with no id, and cleared by the next init', async () => {
    const { createAnalyticsClient, proxy } = load();
    proxy.setAnonymousId('web-1');
    await settle();
    expect(store.get(MARKER)).toBe('1');
    await createAnalyticsClient(opts).getAnonymousId();
    await settle();
    expect(store.has(MARKER)).toBe(false);

    // Over an existing id: no marker.
    const next = load();
    next.proxy.setAnonymousId('web-2');
    await settle();
    expect(store.has(MARKER)).toBe(false);
  });

  it("a host id set while init reads storage doesn't leave the install marker behind", async () => {
    // Fresh install, lifecycle off: init's own read of the marker is the
    // first one. The host sets the id at that moment.
    let proxy: any;
    let fired = false;
    const first = load({
      onGet: (key) => {
        if (key === MARKER && !fired) {
          fired = true;
          proxy.setAnonymousId('web-H');
        }
      },
    });
    proxy = first.proxy;
    const a = first.createAnalyticsClient({
      ...opts,
      trackLifecycleEvents: false,
    });
    expect(await a.getAnonymousId()).toBe('web-H');
    await settle();
    expect(fired).toBe(true);
    expect(store.get(ANON)).toBe('web-H');
    expect(store.has(MARKER)).toBe(false);

    // Launch 2 with lifecycle on: an existing user, not a new install.
    const next = load();
    await next.createAnalyticsClient(opts).getAnonymousId();
    expect(events(next.clients[0])[0].event).toBe('Application Updated');
  });

  it('a client superseded by reset() before its init ran writes no identity', async () => {
    const { createAnalyticsClient, proxy, clients } = load();
    createAnalyticsClient(opts);
    void proxy.reset();
    createAnalyticsClient(opts);
    await waitFor(() => clients[1]?.peekAnonymousId());
    await settle();

    const [superseded, current] = clients;
    const id = current.peekAnonymousId();
    expect(superseded.identityEpoch).toBeLessThan(current.identityEpoch);
    expect(store.get(ANON)).toBe(id);
    expect(writes.filter(([k]) => k === ANON)).toEqual([[ANON, id]]);
  });

  describe('unreadable identity storage', () => {
    it('an anonymousId read that keeps failing gets a launch-only id and never overwrites the stored one', async () => {
      store.set(ANON, 'stored-id');
      const { createAnalyticsClient, failAnonReads } = load();
      // Install detection reads once, the IdentityManager up to three times.
      failAnonReads(4);
      const analytics = createAnalyticsClient({
        ...opts,
        trackLifecycleEvents: false,
      });
      const id = await analytics.getAnonymousId();

      expect(id).not.toBe('stored-id');
      await settle();
      expect(store.get(ANON)).toBe('stored-id');

      // The next launch reads it fine and is back on the stored id.
      const next = load();
      expect(
        await next
          .createAnalyticsClient({ ...opts, trackLifecycleEvents: false })
          .getAnonymousId()
      ).toBe('stored-id');
    });

    it('a read that fails and then succeeds keeps the stored id', async () => {
      store.set(ANON, 'stored-id');
      const { createAnalyticsClient, failAnonReads } = load();
      failAnonReads(1);
      const analytics = createAnalyticsClient({
        ...opts,
        trackLifecycleEvents: false,
      });
      expect(await analytics.getAnonymousId()).toBe('stored-id');
    });

    it('a host id still replaces an unreadable stored id', async () => {
      store.set(ANON, 'stored-id');
      const { createAnalyticsClient, proxy, failAnonReads } = load();
      failAnonReads(4);
      proxy.setAnonymousId('web-4');
      const analytics = createAnalyticsClient({
        ...opts,
        trackLifecycleEvents: false,
      });
      expect(await analytics.getAnonymousId()).toBe('web-4');
      await settle();
      expect(store.get(ANON)).toBe('web-4');
    });
  });
});

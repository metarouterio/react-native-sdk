import type { InitOptions } from './types';

// Session-level behaviour of the invalid-config contract: the gate in
// createAnalyticsClient, the refused session, recovery, and the ordering of
// back-to-back init / invalid-init / reset calls. Mirrors the Android SDK's
// MetaRouterTest coverage for the same contract.

global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200 })) as any;

jest.mock('./utils/identityStorage', () => ({
  getIdentityField: jest.fn(),
  setIdentityField: jest.fn(),
  removeIdentityField: jest.fn(),
  ANONYMOUS_ID_KEY: 'metarouter:anonymous_id',
  USER_ID_KEY: 'metarouter:user_id',
  GROUP_ID_KEY: 'metarouter:group_id',
  ADVERTISING_ID_KEY: 'metarouter:advertising_id',
}));

const valid: InitOptions = {
  writeKey: 'test_write_key',
  ingestionHost: 'https://example.com',
};
const invalid: InitOptions = {
  writeKey: '   ',
  ingestionHost: valid.ingestionHost,
};

/**
 * Re-applied after every jest.resetModules(): a reset re-creates the mocked
 * module with bare jest.fn()s, and a client would then mint a new random
 * anonymousId instead of reading the stored one.
 */
function mockIdentityStorage() {
  const identityStorage = require('./utils/identityStorage');
  (identityStorage.getIdentityField as jest.Mock).mockImplementation(
    async (key: string) =>
      key === identityStorage.ANONYMOUS_ID_KEY ? 'anon-123' : undefined
  );
  (identityStorage.setIdentityField as jest.Mock).mockResolvedValue(undefined);
  (identityStorage.removeIdentityField as jest.Mock).mockResolvedValue(
    undefined
  );
}

/** Fresh module graph per test: the session state in init.ts is module-level. */
function load(opts: { development?: boolean } = {}) {
  const init = require('./init');
  init.buildConfig.isDevelopmentBuild = () => opts.development ?? false;
  const { MetaRouterAnalyticsClient } = require('./MetaRouterAnalyticsClient');
  return {
    createAnalyticsClient: init.createAnalyticsClient as (
      o: InitOptions
    ) => any,
    ClientClass: MetaRouterAnalyticsClient,
  };
}

/** Lets every queued init/disable/reset step run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function lifecycleOf(client: any): Promise<string> {
  await settle();
  return (await client.getDebugInfo()).lifecycle;
}

describe('invalid InitOptions', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockIdentityStorage();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  it('in a release build leaves the SDK inert and signals', async () => {
    const { createAnalyticsClient } = load();
    const onConfigError = jest.fn();

    const client = createAnalyticsClient({ ...invalid, onConfigError });

    expect(onConfigError).toHaveBeenCalledTimes(1);
    expect(onConfigError).toHaveBeenCalledWith({
      type: 'emptyWriteKey',
      description: 'writeKey must not be empty or whitespace-only',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[MetaRouter] MetaRouter disabled for this session — writeKey must not be empty or whitespace-only'
    );
    expect(() => client.track('Nothing happens')).not.toThrow();

    const debug = await (await settle(), client.getDebugInfo());
    expect(debug).toMatchObject({
      lifecycle: 'disabled',
      proxy: true,
      configError: 'writeKey must not be empty or whitespace-only',
    });
    expect(await client.getAnonymousId()).toBe('');
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it('in a development build throws at createAnalyticsClient and leaves state untouched', async () => {
    const { createAnalyticsClient } = load({ development: true });
    const onConfigError = jest.fn();

    const client = createAnalyticsClient(valid);
    await client.getAnonymousId();

    expect(() => createAnalyticsClient({ ...invalid, onConfigError })).toThrow(
      'Invalid InitOptions: writeKey must not be empty or whitespace-only'
    );
    expect(onConfigError).not.toHaveBeenCalled();
    expect(await lifecycleOf(client)).toBe('ready');
    await client.reset();
  });

  it('settles a getAnonymousId made before the refusal ran with "" instead of hanging', async () => {
    const { createAnalyticsClient } = load();
    const client = createAnalyticsClient(invalid);
    // Called before the queued disable has run, so it waits like any
    // pre-init call — and must be released by the refusal.
    await expect(client.getAnonymousId()).resolves.toBe('');
  });

  it('an invalid re-init disables the running session and resets its client', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    const resetSpy = jest.spyOn(ClientClass.prototype, 'reset');

    const client = createAnalyticsClient(valid);
    await client.getAnonymousId();
    createAnalyticsClient(invalid);

    expect(await lifecycleOf(client)).toBe('disabled');
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('a valid createAnalyticsClient after a refusal recovers the session', async () => {
    const { createAnalyticsClient } = load();
    const client = createAnalyticsClient(invalid);
    await settle();

    createAnalyticsClient(valid);
    expect(await client.getAnonymousId()).toBe('anon-123');
    const debug = await client.getDebugInfo();
    expect(debug.lifecycle).toBe('ready');
    expect(debug.configError).toBeUndefined();
    await client.reset();
  });

  it('reset() clears the refusal so the next session can bind', async () => {
    const { createAnalyticsClient } = load();
    const client = createAnalyticsClient(invalid);
    await settle();

    await client.reset();
    createAnalyticsClient(valid);
    expect(await client.getAnonymousId()).toBe('anon-123');
    expect(await lifecycleOf(client)).toBe('ready');
    await client.reset();
  });

  it('replays calls made while refused into the recovered session', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    const trackSpy = jest.spyOn(ClientClass.prototype, 'track');
    const client = createAnalyticsClient(invalid);
    await settle();

    client.track('Queued While Disabled');
    createAnalyticsClient(valid);
    await client.getAnonymousId();

    expect(trackSpy).toHaveBeenCalledWith('Queued While Disabled', undefined);
    await client.reset();
  });

  it('logs construction warnings once per call, not again when the client is built', async () => {
    const { createAnalyticsClient } = load();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const client = createAnalyticsClient({
      ...valid,
      ingestionHost: 'http://collector.example.com',
    });
    await client.getAnonymousId();

    const cleartext = warnSpy.mock.calls.filter((c) =>
      c.join(' ').includes('cleartext')
    );
    expect(cleartext).toHaveLength(1);
    warnSpy.mockRestore();
    await client.reset();
  });

  it('a failed init does not undo a reset and init queued behind it', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    jest
      .spyOn(ClientClass.prototype, 'init')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const client = createAnalyticsClient(valid); // this init fails
    void client.reset();
    createAnalyticsClient({ ...valid, maxQueueEvents: 3000 });
    expect(await client.getAnonymousId()).toBe('anon-123');

    // The failed init's rollback must not have marked the session as not
    // started: reset() has to tear the bound client down for real, and the
    // next createAnalyticsClient has to bind its own options.
    await client.reset();
    createAnalyticsClient({ ...valid, maxQueueEvents: 4000 });
    await client.getAnonymousId();
    expect((await client.getDebugInfo()).maxQueueEvents).toBe(4000);
    await client.reset();
  });

  it('a failed init alone leaves the SDK retryable', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    jest
      .spyOn(ClientClass.prototype, 'init')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    const client = createAnalyticsClient(valid);
    await settle();
    createAnalyticsClient(valid);
    expect(await client.getAnonymousId()).toBe('anon-123');
    await client.reset();
  });

  it('a constructor that throws gets the same rollback as a failed init', async () => {
    jest.doMock('./utils/debouncedNetworkMonitor', () => {
      const actual = jest.requireActual('./utils/debouncedNetworkMonitor');
      let first = true;
      return {
        DebouncedNetworkMonitor: function (this: any, ...args: any[]) {
          if (first) {
            first = false;
            throw new Error('native module missing');
          }
          return new actual.DebouncedNetworkMonitor(...args);
        },
      };
    });
    const { createAnalyticsClient } = load();

    const client = createAnalyticsClient(valid);
    await settle();
    createAnalyticsClient(valid);
    expect(await client.getAnonymousId()).toBe('anon-123');
    await client.reset();
    jest.dontMock('./utils/debouncedNetworkMonitor');
  });

  it('a reset whose client teardown throws still unbinds and recovers', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    const client = createAnalyticsClient(valid);
    await client.getAnonymousId();
    jest
      .spyOn(ClientClass.prototype, 'reset')
      .mockRejectedValueOnce(new Error('AsyncStorage failure'));

    await expect(client.reset()).resolves.toBeUndefined();
    createAnalyticsClient({ ...valid, maxQueueEvents: 3000 });
    await client.getAnonymousId();
    const debug = await client.getDebugInfo();
    expect(debug.lifecycle).toBe('ready');
    expect(debug.maxQueueEvents).toBe(3000);
    await client.reset();
  });

  it.each([401, 403, 404])(
    'never calls onConfigError for a %p from the ingestion host',
    async (status) => {
      // Auth and routing failures stop the dispatcher through their own
      // fatal-config path; onConfigError is for options rejected at init.
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status,
        headers: { get: () => null },
      });
      const { createAnalyticsClient } = load();
      const onConfigError = jest.fn();
      const client = createAnalyticsClient({ ...valid, onConfigError });
      await client.getAnonymousId();

      client.track('Rejected Upstream');
      await client.flush();

      expect(global.fetch).toHaveBeenCalled();
      expect(onConfigError).not.toHaveBeenCalled();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
      await client.reset();
    }
  );

  it('signals again on a second invalid call and stays refused', async () => {
    const { createAnalyticsClient } = load();
    const onConfigError = jest.fn();
    const client = createAnalyticsClient({ ...invalid, onConfigError });
    await settle();
    createAnalyticsClient({ ...invalid, onConfigError });

    expect(onConfigError).toHaveBeenCalledTimes(2);
    expect(await lifecycleOf(client)).toBe('disabled');
    expect(await client.getAnonymousId()).toBe('');
  });

  it('a refused session whose recovering init fails is recovered by the next valid call', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    const client = createAnalyticsClient(invalid);
    await settle();
    jest
      .spyOn(ClientClass.prototype, 'init')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    createAnalyticsClient(valid); // this init fails
    await settle();
    createAnalyticsClient(valid);
    expect(await client.getAnonymousId()).toBe('anon-123');
    expect(await lifecycleOf(client)).toBe('ready');
    await client.reset();
  });

  it('keeps at most 20 calls while refused, dropping the oldest', async () => {
    const { createAnalyticsClient, ClientClass } = load();
    const trackSpy = jest.spyOn(ClientClass.prototype, 'track');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createAnalyticsClient(invalid);
    await settle();

    for (let i = 0; i < 25; i++) client.track(`Event ${i}`);
    createAnalyticsClient(valid);
    // Settle instead of awaiting a query: a query made now would take a
    // queue slot itself and evict one more event.
    await settle();

    const replayed = trackSpy.mock.calls.map(([name]) => name);
    expect(replayed).toHaveLength(20);
    expect(replayed[0]).toBe('Event 5');
    expect(replayed[19]).toBe('Event 24');
    warnSpy.mockRestore();
    await client.reset();
  });

  it('a throwing onConfigError propagates and leaves a running session running', async () => {
    // Same order as native: the callback runs before the refusal is
    // recorded, so its throw leaves nothing recorded and nothing queued.
    const { createAnalyticsClient, ClientClass } = load();
    const resetSpy = jest.spyOn(ClientClass.prototype, 'reset');
    const client = createAnalyticsClient(valid);
    await client.getAnonymousId();

    expect(() =>
      createAnalyticsClient({
        ...invalid,
        onConfigError: () => {
          throw new Error('host bug');
        },
      })
    ).toThrow('host bug');

    expect(await lifecycleOf(client)).toBe('ready');
    expect(resetSpy).not.toHaveBeenCalled();
    await client.reset();
  });

  // Back-to-back sequences with no settling between calls. Each would end
  // stuck (bound to nothing, or disabled with no way out) if a queued step
  // wrote the session flags when it ran instead of when it was queued. One run
  // each: JS microtask order is fixed, so repeating a sequence replays the
  // same schedule.
  describe('ordering of back-to-back calls', () => {
    it('invalid then valid createAnalyticsClient ends ready', async () => {
      const { createAnalyticsClient } = load();
      createAnalyticsClient(invalid);
      const client = createAnalyticsClient(valid);
      expect(await client.getAnonymousId()).toBe('anon-123');
      expect(await lifecycleOf(client)).toBe('ready');
      await client.reset();
    });

    it('valid then invalid ends disabled, and a later valid call recovers', async () => {
      const { createAnalyticsClient } = load();
      createAnalyticsClient(valid);
      const client = createAnalyticsClient(invalid);
      expect(await lifecycleOf(client)).toBe('disabled');

      createAnalyticsClient(valid);
      expect(await client.getAnonymousId()).toBe('anon-123');
      expect(await lifecycleOf(client)).toBe('ready');
      await client.reset();
    });

    it('valid, reset, valid ends ready with the second session', async () => {
      const { createAnalyticsClient } = load();
      const client = createAnalyticsClient(valid);
      const resetDone = client.reset();
      createAnalyticsClient({ ...valid, maxQueueEvents: 3000 });
      await resetDone;
      expect(await client.getAnonymousId()).toBe('anon-123');
      const debug = await client.getDebugInfo();
      expect(debug.lifecycle).toBe('ready');
      expect(debug.maxQueueEvents).toBe(3000);
      await client.reset();
    });

    it('invalid then reset() ends unbound and not refused, so the next valid call binds', async () => {
      const { createAnalyticsClient } = load();
      const onConfigError = jest.fn();
      const client = createAnalyticsClient({ ...invalid, onConfigError });
      await client.reset();

      // Not refused any more: a query waits for the next bind instead of
      // answering with the disabled verdict.
      let answered = false;
      void client.getAnonymousId().then(() => (answered = true));
      await settle();
      expect(answered).toBe(false);

      createAnalyticsClient(valid);
      expect(await client.getAnonymousId()).toBe('anon-123');
      await client.reset();
    });
  });
});

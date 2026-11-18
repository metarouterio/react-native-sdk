import { NativeModules } from 'react-native';
import type { Consent } from './consent';
import { ConsentManager, MAX_PLAUSIBLE_HOST_TIMESTAMP } from './consentManager';
import type { StoredConsent } from './consentStorage';

/**
 * A manager over in-memory storage and a recorded dispatcher: deliveries run
 * only when the test drains them, which is how queued-vs-inline is checked.
 */
function makeManager(
  opts: {
    stored?: StoredConsent | null;
    loadFails?: boolean;
    clock?: () => number;
    failFast?: boolean;
  } = {}
) {
  const store = {
    value: opts.stored ?? null,
    saves: [] as (StoredConsent | null)[],
  };
  const queue: (() => void)[] = [];
  let releaseLoad!: () => void;
  const gate = new Promise<void>((r) => (releaseLoad = r));
  const manager = new ConsentManager(
    {
      load: async () => {
        await gate;
        if (opts.loadFails) throw new Error('storage busy');
        return store.value;
      },
      save: async (s) => {
        store.saves.push(s);
        store.value = s ? JSON.parse(JSON.stringify(s)) : null;
      },
    },
    opts.clock ?? (() => 1000),
    (work) => queue.push(work),
    () => opts.failFast ?? false
  );
  const drain = () => {
    while (queue.length) queue.shift()!();
  };
  return { manager, store, queue, drain, releaseLoad };
}

async function loaded(opts: Parameters<typeof makeManager>[0] = {}) {
  const m = makeManager(opts);
  m.releaseLoad();
  await m.manager.load();
  return m;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const native = NativeModules.MetaRouterKeyValueStore as { getSync: jest.Mock };
const registry = [{ key: 'c0001', defaultOptOut: false }, { key: 'c0002' }];

describe('ConsentManager', () => {
  describe('state', () => {
    it('is the empty implicit default before anything, then the registry default', async () => {
      const { manager } = await loaded();
      expect(manager.getConsent()).toEqual({ explicit: false, optOut: {} });

      manager.registerConsentCategories(registry);
      expect(manager.getConsent()).toEqual({
        explicit: false,
        optOut: { c0001: false, c0002: true },
      });
    });

    it('reconciles, persists, and replaces rather than merges', async () => {
      const { manager, store } = await loaded();
      manager.registerConsentCategories(registry);

      expect(
        manager.setConsent({ explicit: true, optOut: { c0002: false } })
      ).toBe(true);
      expect(
        manager.setConsent({ explicit: true, optOut: { c0001: true } })
      ).toBe(true);
      await flush();

      expect(manager.getConsent().optOut).toEqual({ c0001: true, c0002: true });
      // The RAW snapshot is stored, not the reconciled view.
      expect(store.value!.consent.optOut).toEqual({ c0001: true });
    });

    it('stamps the clock when untimestamped, keeps a host timestamp', async () => {
      const { manager } = await loaded({ clock: () => 42 });
      manager.setConsent({ explicit: true, optOut: {} });
      expect(manager.getConsent().timestamp).toBe(42);
      manager.setConsent({ explicit: true, optOut: {}, timestamp: 7 });
      expect(manager.getConsent().timestamp).toBe(7);
    });

    it('a set before registration passes through; registration completes it', async () => {
      const { manager } = await loaded();
      manager.setConsent({
        explicit: true,
        optOut: { C0002: false, extra: true },
      });
      expect(manager.getConsent().optOut).toEqual({
        c0002: false,
        extra: true,
      });

      manager.registerConsentCategories(registry);
      expect(manager.getConsent().optOut).toEqual({
        c0001: false,
        c0002: false,
      });
    });

    it('re-registration never loses the decision for a dropped key', async () => {
      const { manager } = await loaded();
      manager.registerConsentCategories(registry);
      manager.setConsent({ explicit: true, optOut: { c0001: true } });
      manager.registerConsentCategories([{ key: 'c0002' }]);
      manager.registerConsentCategories(registry);
      expect(manager.getConsent().optOut.c0001).toBe(true);
    });

    it('an empty registration after a non-empty one falls back to passthrough', async () => {
      const { manager } = await loaded();
      manager.registerConsentCategories(registry);
      manager.setConsent({ explicit: true, optOut: { extra: true } });
      manager.registerConsentCategories([]);
      expect(manager.getConsent().optOut).toEqual({ extra: true });
    });

    it('handed-out consent is frozen; host mutation of its input changes nothing', async () => {
      const { manager } = await loaded();
      const input = {
        explicit: true,
        optOut: { a: false } as Record<string, boolean>,
      };
      manager.setConsent(input);
      input.optOut.a = true;
      input.optOut.b = true;

      expect(manager.getConsent().optOut).toEqual({ a: false });
      expect(Object.isFrozen(manager.getConsent().optOut)).toBe(true);
    });
  });

  describe('input from untyped hosts', () => {
    it.each([
      null,
      'yes',
      1,
      {},
      { explicit: true },
      { explicit: true, optOut: [] },
      { explicit: true, optOut: new Map([['a', true]]) },
      { explicit: true, optOut: new Set(['a']) },
      { explicit: true, optOut: Promise.resolve({ a: true }) },
      { explicit: true, optOut: new Date(0) },
    ])('rejects %p without throwing', async (input) => {
      const { manager } = await loaded();
      expect(manager.setConsent(input as any)).toBe(false);
      expect(manager.getConsent()).toEqual({ explicit: false, optOut: {} });
    });

    it('rejects a non-plain optOut and keeps the previous state', async () => {
      class Purposes {
        c0002 = true;
      }
      const { manager } = await loaded();
      manager.setConsent({ explicit: true, optOut: { c0002: true } });
      expect(
        manager.setConsent({ explicit: true, optOut: new Purposes() })
      ).toBe(false);
      expect(manager.getConsent().optOut).toEqual({ c0002: true });
    });

    it('loads synchronously from native storage through the real consent storage', () => {
      native.getSync.mockReturnValueOnce(
        JSON.stringify({
          consent: { explicit: true, optOut: { c0004: true } },
          lastHostTimestamp: 7,
        })
      );
      const manager = new ConsentManager();
      void manager.load();
      expect(manager.getConsent()).toEqual({
        explicit: true,
        optOut: { c0004: true },
      });
      expect(native.getSync).toHaveBeenCalledWith('metarouter:consent:state');
    });

    it('a non-boolean optOut value counts as opted out; non-boolean explicit as false', async () => {
      const { manager } = await loaded();
      manager.setConsent({
        explicit: 'yes',
        optOut: { a: 0, b: false, c: 'false' },
      } as any);
      expect(manager.getConsent()).toMatchObject({
        explicit: false,
        optOut: { a: true, b: false, c: true },
      });
    });
  });

  describe('hostile input never throws', () => {
    it('setConsent (any build) and registerConsentCategories (release) with throwing getters', async () => {
      const { manager } = await loaded({ failFast: true });
      const throwing = {
        explicit: true,
        get optOut(): Record<string, boolean> {
          throw new Error('vendor bug');
        },
      };
      expect(manager.setConsent(throwing as any)).toBe(false);
      const release = await loaded();
      expect(() =>
        release.manager.registerConsentCategories([
          {
            get key(): string {
              throw new Error('vendor bug');
            },
          },
        ])
      ).not.toThrow();
    });

    it('applies a non-number timestamp as untimestamped, so a withdrawal is never dropped', async () => {
      const { manager } = await loaded({ clock: () => 7 });
      manager.setConsent({
        explicit: true,
        optOut: { a: false },
        timestamp: 500,
      });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: true },
          timestamp: new Date(100),
        } as any)
      ).toBe(true);
      expect(manager.getConsent()).toMatchObject({
        optOut: { a: true },
        timestamp: 7,
      });
    });

    it('a digit-string timestamp is still subject to the staleness check', async () => {
      const { manager } = await loaded();
      manager.setConsent({
        explicit: true,
        optOut: { a: false },
        timestamp: 500,
      });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: true },
          timestamp: '100',
        } as any)
      ).toBe(false);
    });

    it('a non-array registration keeps the registry, like unreadable input', async () => {
      const { manager } = await loaded();
      manager.registerConsentCategories([{ key: 'c0001' }]);
      manager.registerConsentCategories(undefined as any);
      expect(manager.getConsent().optOut).toEqual({ c0001: true });
    });

    it('a development build still throws on unreadable categories', async () => {
      const { manager } = await loaded({ failFast: true });
      const throwingList = new Proxy([], {
        get() {
          throw new Error('not loaded');
        },
      });
      expect(() =>
        manager.registerConsentCategories(throwingList as any)
      ).toThrow('not loaded');
    });

    it('the stamped wire shape is frozen and tracks the decision', async () => {
      const { manager } = await loaded();
      const before = manager.getWireConsent();
      expect(Object.isFrozen(before)).toBe(true);
      manager.setConsent({ explicit: true, optOut: { a: true } });
      expect(manager.getWireConsent()).toEqual({
        explicit: true,
        optOut: { a: true },
      });
      expect(manager.getWireConsent()).toEqual({
        explicit: manager.getConsent().explicit,
        optOut: manager.getConsent().optOut,
      });
    });

    it('a non-boolean defaultOptOut is a registration problem', async () => {
      const dev = await loaded({ failFast: true });
      expect(() =>
        dev.manager.registerConsentCategories([
          { key: 'c0001', defaultOptOut: 'false' as any },
        ])
      ).toThrow('not a boolean');

      const release = await loaded();
      release.manager.registerConsentCategories([
        { key: 'c0001', defaultOptOut: 'false' as any },
      ]);
      expect(release.manager.getConsent().optOut).toEqual({ c0001: true });
    });
  });

  describe('staleness', () => {
    it('ignores an older host timestamp, accepts an equal one', async () => {
      const { manager } = await loaded();
      manager.setConsent({
        explicit: true,
        optOut: { a: true },
        timestamp: 200,
      });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 100,
        })
      ).toBe(false);
      expect(manager.getConsent().optOut.a).toBe(true);
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 200,
        })
      ).toBe(true);
    });

    it('never rejects an untimestamped set, even when the clock moved back', async () => {
      let now = 5000;
      const { manager } = await loaded({ clock: () => now });
      manager.setConsent({ explicit: true, optOut: { a: true } });
      now = 1;
      expect(manager.setConsent({ explicit: true, optOut: { a: false } })).toBe(
        true
      );
    });

    it('an untimestamped re-push carries the watermark forward', async () => {
      const { manager } = await loaded();
      manager.setConsent({
        explicit: true,
        optOut: { a: true },
        timestamp: 200,
      });
      manager.setConsent({ explicit: true, optOut: { a: true } });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 100,
        })
      ).toBe(false);
      // Reset-then-accept: a newer host snapshot moves it on.
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 300,
        })
      ).toBe(true);
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: true },
          timestamp: 300,
        })
      ).toBe(true);
    });

    it('a banner choice with server time is not rejected after a device-stamped default', async () => {
      const { manager } = await loaded({ clock: () => 10_000 });
      manager.setConsent({ explicit: false, optOut: { a: true } });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 9_000,
        })
      ).toBe(true);
    });

    it('applies a micro/nanosecond timestamp as untimestamped', async () => {
      const { manager } = await loaded({ clock: () => 1 });
      manager.setConsent({
        explicit: true,
        optOut: {},
        timestamp: MAX_PLAUSIBLE_HOST_TIMESTAMP + 1,
      });
      expect(manager.getConsent().timestamp).toBe(1);
      expect(
        manager.setConsent({ explicit: true, optOut: {}, timestamp: 5 })
      ).toBe(true);
    });
  });

  describe('clearConsent', () => {
    it('returns to the implicit default and wipes storage, watermark included', async () => {
      const { manager, store } = await loaded();
      manager.registerConsentCategories(registry);
      manager.setConsent({
        explicit: true,
        optOut: { c0001: true },
        timestamp: 500,
      });
      manager.clearConsent();
      await flush();

      expect(manager.getConsent()).toEqual({
        explicit: false,
        optOut: { c0001: false, c0002: true },
      });
      expect(store.value).toBeNull();
      expect(
        manager.setConsent({ explicit: true, optOut: {}, timestamp: 100 })
      ).toBe(true);
    });

    it('a replay after clear is applied, so an opt-in default cannot opt the user in', async () => {
      const { manager } = await loaded();
      manager.registerConsentCategories(registry); // c0001 defaults opted in
      const rejectAll = {
        explicit: true,
        optOut: { c0001: true, c0002: true },
        timestamp: 100,
      };
      manager.setConsent(rejectAll);
      manager.clearConsent(); // logout
      expect(manager.setConsent(rejectAll)).toBe(true); // CMP replays its cache
      expect(manager.getConsent().optOut.c0001).toBe(true);
    });
  });

  describe('registration problems', () => {
    it('degrades with warnings in release', async () => {
      const { manager } = await loaded();
      manager.registerConsentCategories([
        { key: ' C0001 ' },
        { key: '' },
        { key: 'c0001', defaultOptOut: false },
        null as any,
      ]);
      expect(manager.getConsent().optOut).toEqual({ c0001: true });
    });

    it('throws in development and leaves the registry unchanged', async () => {
      const { manager } = await loaded({ failFast: true });
      manager.registerConsentCategories(registry);
      expect(() =>
        manager.registerConsentCategories([{ key: 'C0001' }])
      ).toThrow('normalized to "c0001"');
      expect(manager.getConsent().optOut).toEqual({
        c0001: false,
        c0002: true,
      });
      expect(() =>
        manager.registerConsentCategories([{ key: 'c0003' }])
      ).not.toThrow();
    });
  });

  describe('subscriptions', () => {
    it('queues the current value, never inline, then fires only on real changes', async () => {
      const { manager, drain } = await loaded();
      const seen: Consent[] = [];
      manager.subscribe((c) => seen.push(c));
      expect(seen).toHaveLength(0); // queued, not inline
      drain();
      expect(seen).toHaveLength(1);

      manager.setConsent({ explicit: true, optOut: { a: true } });
      manager.setConsent({ explicit: true, optOut: { a: true }, timestamp: 5 }); // same decision
      drain();
      expect(seen.map((c) => c.optOut)).toEqual([{}, { a: true }]);
    });

    it('a first set equal to the implicit default does not fire', async () => {
      const { manager, drain } = await loaded();
      manager.registerConsentCategories(registry);
      const handler = jest.fn();
      manager.subscribe(handler);
      drain();
      manager.setConsent({ explicit: false, optOut: {} });
      drain();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('registration notifies when the visible default changes; a no-op one does not', async () => {
      const { manager, drain } = await loaded();
      const handler = jest.fn();
      manager.subscribe(handler);
      drain();
      manager.registerConsentCategories(registry);
      manager.registerConsentCategories(registry);
      drain();
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('delivers in commit order to every subscriber', async () => {
      const { manager, drain } = await loaded();
      const a: boolean[] = [];
      const b: boolean[] = [];
      manager.subscribe((c) => a.push(c.optOut.x === true));
      manager.subscribe((c) => b.push(c.optOut.x === true));
      manager.setConsent({ explicit: true, optOut: { x: true } });
      manager.setConsent({ explicit: true, optOut: { x: false } });
      drain();
      expect(a).toEqual([false, true, false]);
      expect(b).toEqual([false, true, false]);
    });

    it('unsubscribe is idempotent and cancels deliveries already queued', async () => {
      const { manager, drain } = await loaded();
      const handler = jest.fn();
      const unsubscribe = manager.subscribe(handler);
      manager.setConsent({ explicit: true, optOut: { a: true } });
      unsubscribe();
      unsubscribe();
      drain();
      expect(handler).not.toHaveBeenCalled();
    });

    it('a handler may unsubscribe itself, or re-enter the manager, during delivery', async () => {
      const { manager, drain } = await loaded();
      const calls: Consent[] = [];
      const unsubscribe = manager.subscribe((c) => {
        calls.push(c);
        unsubscribe();
        manager.setConsent({ explicit: true, optOut: { nested: true } });
      });
      drain();
      expect(calls).toHaveLength(1);
      expect(manager.getConsent().optOut).toEqual({ nested: true });
    });

    it('a throwing handler does not stop the others', async () => {
      const { manager, drain } = await loaded();
      const other = jest.fn();
      manager.subscribe(() => {
        throw new Error('host bug');
      });
      manager.subscribe(other);
      drain();
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('the default dispatcher delivers asynchronously', async () => {
      const manager = new ConsentManager({
        load: async () => null,
        save: async () => {},
      });
      await manager.load();
      const handler = jest.fn();
      manager.subscribe(handler);
      expect(handler).not.toHaveBeenCalled();
      await flush();
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('load', () => {
    it('loads the stored state and notifies subscribers', async () => {
      const { manager, drain, releaseLoad } = makeManager({
        stored: {
          consent: { explicit: true, optOut: { a: true } },
          lastHostTimestamp: 50,
        },
      });
      const handler = jest.fn();
      manager.subscribe(handler);
      releaseLoad();
      await manager.load();
      drain();

      expect(manager.getConsent().optOut).toEqual({ a: true });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('a write before the load wins over stored state and is saved', async () => {
      const { manager, store, releaseLoad } = makeManager({
        stored: { consent: { explicit: true, optOut: { a: true } } },
      });
      manager.setConsent({ explicit: true, optOut: { a: false } });
      expect(store.saves).toEqual([]); // nothing saved before the load
      releaseLoad();
      await manager.load();
      await flush();

      expect(manager.getConsent().optOut).toEqual({ a: false });
      expect(store.value!.consent.optOut).toEqual({ a: false });
    });

    it('a timestamped write older than the stored watermark loses at load', async () => {
      const { manager, releaseLoad } = makeManager({
        stored: {
          consent: { explicit: true, optOut: { a: true }, timestamp: 500 },
          lastHostTimestamp: 500,
        },
      });
      expect(
        manager.setConsent({
          explicit: true,
          optOut: { a: false },
          timestamp: 100,
        })
      ).toBe(true);
      releaseLoad();
      await manager.load();
      expect(manager.getConsent().optOut).toEqual({ a: true });
    });

    it('a clear before the load wipes the stored state; a set after it applies', async () => {
      const { manager, store, releaseLoad } = makeManager({
        stored: {
          consent: { explicit: true, optOut: { a: true }, timestamp: 500 },
          lastHostTimestamp: 500,
        },
      });
      manager.clearConsent();
      manager.setConsent({
        explicit: true,
        optOut: { b: true },
        timestamp: 100,
      });
      releaseLoad();
      await manager.load();
      await flush();

      expect(manager.getConsent().optOut).toEqual({ b: true });
      expect(store.value!.lastHostTimestamp).toBe(100);
    });

    it('an unreadable store is never overwritten, but a clear still reaches it', async () => {
      const { manager, store } = await loaded({
        stored: { consent: { explicit: true, optOut: { a: true } } },
        loadFails: true,
      });
      manager.setConsent({ explicit: true, optOut: { b: true } });
      await flush();
      expect(store.saves).toEqual([]);

      manager.clearConsent();
      manager.setConsent({ explicit: true, optOut: { c: true } });
      await flush();
      expect(store.saves[store.saves.length - 1]!.consent.optOut).toEqual({
        c: true,
      });
    });

    it('a synchronous load is in memory before load() returns, and replays nothing', () => {
      const save = jest.fn(async () => {});
      const manager = new ConsentManager({
        loadSync: () => ({ consent: { explicit: true, optOut: { a: true } } }),
        load: async () => {
          throw new Error('not used');
        },
        save,
      });
      void manager.load();
      expect(manager.getConsent()).toEqual({
        explicit: true,
        optOut: { a: true },
      });
      expect(save).not.toHaveBeenCalled();
    });

    it('no synchronous state falls back to the asynchronous load', async () => {
      const manager = new ConsentManager({
        loadSync: () => undefined,
        load: async () => ({
          consent: { explicit: true, optOut: { b: true } },
        }),
        save: async () => {},
      });
      await manager.load();
      expect(manager.getConsent().optOut).toEqual({ b: true });
    });

    it('a failing synchronous read is unreadable storage: memory only, but a clear is saved', async () => {
      const save = jest.fn(async () => {});
      const manager = new ConsentManager({
        loadSync: () => {
          throw new Error('sync calls unsupported');
        },
        load: async () => null,
        save,
      });
      await manager.load();
      manager.setConsent({ explicit: true, optOut: { a: true } });
      await flush();
      expect(save).not.toHaveBeenCalled();

      manager.clearConsent();
      await flush();
      expect(save).toHaveBeenCalledWith(null);
    });

    it('load always resolves', async () => {
      const manager = new ConsentManager({
        load: async () => ({ consent: null }) as any,
        save: async () => {},
      });
      await expect(manager.load()).resolves.toBeUndefined();
      // The malformed state was never committed, so later calls still work.
      expect(() => manager.registerConsentCategories(registry)).not.toThrow();
      expect(manager.getConsent().explicit).toBe(false);
    });
  });
});

describe('ConsentManager fail-fast switch', () => {
  it('follows the SDK-wide buildConfig, so tests can exercise the release path', () => {
    const { buildConfig } = require('../utils/buildConfig');
    const original = buildConfig.isDevelopmentBuild;
    const manager = new ConsentManager({
      load: async () => null,
      save: async () => {},
    });
    try {
      buildConfig.isDevelopmentBuild = () => false;
      expect(() =>
        manager.registerConsentCategories([{ key: 'C1' }])
      ).not.toThrow();
      buildConfig.isDevelopmentBuild = () => true;
      expect(() =>
        manager.registerConsentCategories([{ key: 'C1' }])
      ).toThrow();
    } finally {
      buildConfig.isDevelopmentBuild = original;
    }
  });
});

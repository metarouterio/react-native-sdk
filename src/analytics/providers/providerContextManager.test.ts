import {
  MAX_TOTAL_BYTES,
  MAX_VALUE_BYTES,
  ProviderContextManager,
} from './providerContextManager';
import type { ProviderContextMap } from './providerContextStorage';

/** A manager over in-memory storage; `persisted` is what storage holds. */
function makeManager(initial: ProviderContextMap | null = null) {
  const store: { persisted: ProviderContextMap | null; saves: number } = {
    persisted: initial,
    saves: 0,
  };
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => (releaseLoad = resolve));
  const manager = new ProviderContextManager({
    load: async () => {
      await loadGate;
      return store.persisted;
    },
    save: async (map) => {
      store.saves++;
      store.persisted = Object.keys(map).length
        ? JSON.parse(JSON.stringify(map))
        : null;
    },
  });
  return { manager, store, releaseLoad };
}

async function loaded(initial: ProviderContextMap | null = null) {
  const m = makeManager(initial);
  m.releaseLoad();
  await m.manager.load();
  return m;
}

const flushPersist = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ProviderContextManager', () => {
  describe('writes', () => {
    it('sets a value readable at once, names trimmed but not recased', async () => {
      const { manager } = await loaded();

      expect(
        manager.setValue(' googleFirebase ', ' appInstanceId ', 'abc')
      ).toBe(true);

      expect(manager.getAll()).toEqual({
        googleFirebase: { appInstanceId: 'abc' },
      });
    });

    it('null and undefined remove the key; the last key removes the provider', async () => {
      const { manager } = await loaded();
      manager.setValue('p', 'a', 1);
      manager.setValue('p', 'b', 2);

      expect(manager.setValue('p', 'a', null)).toBe(true);
      expect(manager.getAll()).toEqual({ p: { b: 2 } });
      expect(manager.setValue('p', 'b', undefined)).toBe(true);
      expect(manager.getAll()).toEqual({});
    });

    it('removing a key that was never set succeeds', async () => {
      const { manager } = await loaded();
      expect(manager.setValue('p', 'missing', null)).toBe(true);
    });

    it('accepts nested JSON, including shared (non-cyclic) references', async () => {
      const { manager } = await loaded();
      const shared = { x: 1 };
      const value = { a: [1, 'two', true, null, { b: shared }], c: shared };

      expect(manager.setValue('p', 'k', value)).toBe(true);
      expect(manager.getAll().p!.k).toEqual(value);
    });

    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a Date', new Date(0)],
      ['a class instance', new (class Foo {})()],
      ['a function', () => 1],
      ['a symbol', Symbol('s')],
      ['a bigint', BigInt(1)],
      ['a Map', new Map()],
      ['nested undefined', { a: undefined }],
      ['nested NaN', [1, NaN]],
      ['an array hole', [1, , 3]], // eslint-disable-line no-sparse-arrays
      ['a symbol key', { [Symbol('s')]: 1 }],
    ])('rejects %s and keeps the prior value', async (_, value) => {
      const { manager } = await loaded();
      manager.setValue('p', 'k', 'prior');

      expect(manager.setValue('p', 'k', value)).toBe(false);
      expect(manager.getAll()).toEqual({ p: { k: 'prior' } });
    });

    it('rejects a cycle', async () => {
      const { manager } = await loaded();
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(manager.setValue('p', 'k', cyclic)).toBe(false);
    });

    it.each([
      'metarouter',
      'MetaRouter',
      'meta_router',
      'Meta-Router',
      ' META.ROUTER ',
    ])('rejects the reserved provider %p', async (name) => {
      const { manager } = await loaded();
      expect(manager.setValue(name, 'sessionID', 'x')).toBe(false);
      expect(manager.getAll()).toEqual({});
    });

    it('accepts names that only contain the reserved word', async () => {
      const { manager } = await loaded();
      expect(manager.setValue('metarouter2', 'k', 1)).toBe(true);
      expect(manager.setValue('métarouter', 'k', 1)).toBe(true);
    });

    it('rejects blank names and names over 64 UTF-8 bytes', async () => {
      const { manager } = await loaded();
      expect(manager.setValue('  ', 'k', 1)).toBe(false);
      expect(manager.setValue('p', '', 1)).toBe(false);
      expect(manager.setValue('é'.repeat(33), 'k', 1)).toBe(false); // 66 bytes
      expect(manager.setValue('é'.repeat(32), 'k', 1)).toBe(true); // 64 bytes
    });

    it('rejects a value over 2 KiB encoded, accepts one at the limit', async () => {
      const { manager } = await loaded();
      // Encoded with its two quotes.
      expect(manager.setValue('p', 'k', 'a'.repeat(MAX_VALUE_BYTES - 2))).toBe(
        true
      );
      expect(manager.setValue('p', 'k', 'a'.repeat(MAX_VALUE_BYTES - 1))).toBe(
        false
      );
      expect(manager.setValue('p', 'k', 'é'.repeat(MAX_VALUE_BYTES / 2))).toBe(
        false
      );
    });

    it('rejects a write that takes the whole map over 16 KiB, keeping prior values', async () => {
      const { manager } = await loaded();
      const big = 'a'.repeat(MAX_VALUE_BYTES - 2);
      let i = 0;
      while (manager.setValue('p', `k${i}`, big)) i++;

      const before = manager.getAll();
      expect(JSON.stringify(before).length).toBeLessThanOrEqual(
        MAX_TOTAL_BYTES
      );
      expect(manager.getAll()).toBe(before);
      expect(i).toBe(7);
    });

    it('accepts a write to an over-budget map when it does not grow it', async () => {
      const big = 'a'.repeat(MAX_VALUE_BYTES - 2);
      const oversize: ProviderContextMap = { p: {} };
      for (let i = 0; i < 10; i++) oversize.p![`k${i}`] = big;
      const { manager } = await loaded(oversize);

      expect(manager.setValue('p', 'k0', 'small')).toBe(true);
      expect(manager.setValue('p', 'extra', big)).toBe(false);
    });

    it('stores "__proto__" as a name, never as a prototype', async () => {
      const { manager } = await loaded();
      expect(manager.setValue('__proto__', '__proto__', 'x')).toBe(true);

      const all = manager.getAll();
      expect(Object.getPrototypeOf(all)).toBe(Object.prototype);
      expect(Object.keys(all)).toEqual(['__proto__']);
      expect(JSON.stringify(all)).toBe('{"__proto__":{"__proto__":"x"}}');
    });

    it('the map is frozen, and later host mutation does not reach it', async () => {
      const { manager } = await loaded();
      const value = { ids: ['a'] };
      manager.setValue('p', 'k', value);
      value.ids.push('b');

      const all = manager.getAll();
      expect(all.p!.k).toEqual({ ids: ['a'] });
      expect(Object.isFrozen(all)).toBe(true);
      expect(Object.isFrozen(all.p)).toBe(true);
      expect(Object.isFrozen((all.p!.k as { ids: string[] }).ids)).toBe(true);
    });

    it('clear removes one provider; clearAll removes everything', async () => {
      const { manager } = await loaded();
      manager.setValue('a', 'k', 1);
      manager.setValue('b', 'k', 2);

      manager.clear(' a ');
      expect(manager.getAll()).toEqual({ b: { k: 2 } });
      manager.clearAll();
      expect(manager.getAll()).toEqual({});
    });

    it('debug info lists key names only, sorted', async () => {
      const { manager } = await loaded();
      manager.setValue('p', 'z', 'secret');
      manager.setValue('p', 'a', 'secret');
      expect(manager.toDebugInfo()).toEqual({ p: ['a', 'z'] });
    });
  });

  describe('robustness', () => {
    it('never throws: a throwing getter, a Symbol name, deep nesting', async () => {
      const { manager } = await loaded();
      const throwing = {
        get id() {
          throw new Error('vendor bug');
        },
      };
      let deep: unknown = 1;
      for (let i = 0; i < 100000; i++) deep = [deep];

      expect(manager.setValue('p', 'k', throwing)).toBe(false);
      expect(manager.setValue(Symbol('p') as any, 'k', 1)).toBe(false);
      expect(manager.setValue('p', 'k', deep)).toBe(false);
      expect(manager.getAll()).toEqual({});
    });

    it('rejects non-string names instead of stamping "undefined"', async () => {
      const { manager } = await loaded();
      expect(manager.setValue(undefined as any, 'k', 1)).toBe(false);
      expect(manager.setValue('p', null as any, 1)).toBe(false);
      manager.clear(undefined as any);
      expect(manager.getAll()).toEqual({});
    });

    it('reserves like native when the engine has Unicode property escapes', async () => {
      const { manager } = await loaded();
      // Node has them: an uncased letter or a non-Latin digit is kept, so the
      // name is not "metarouter" — Android and iOS accept these too.
      expect(manager.setValue('meta中router', 'k', 1)).toBe(true);
      expect(manager.setValue('metarouter١', 'k', 1)).toBe(true);
      expect(manager.setValue('meta·router', 'k', 1)).toBe(false);
    });

    it('a burst of writes queues one save, ending on the latest map', async () => {
      const { manager, store } = await loaded();
      for (let i = 0; i < 20; i++) manager.setValue('p', 'k', i);
      await flushPersist();

      expect(store.saves).toBe(1);
      expect(store.persisted).toEqual({ p: { k: 19 } });
    });
  });

  describe('load and persistence', () => {
    it('loads the persisted map, frozen', async () => {
      const { manager } = await loaded({ p: { k: { nested: [1] } } });
      expect(manager.getAll()).toEqual({ p: { k: { nested: [1] } } });
      expect(
        Object.isFrozen((manager.getAll().p!.k as { nested: number[] }).nested)
      ).toBe(true);
    });

    it('replays writes made before the load over the persisted map, in order', async () => {
      const { manager, store, releaseLoad } = makeManager({
        old: { a: 1, b: 2 },
        gone: { x: 1 },
      });
      manager.setValue('old', 'a', null); // removes a persisted key
      manager.clear('gone'); // finds nothing in memory yet, still applies
      manager.setValue('fresh', 'k', 'v');
      expect(manager.getAll()).toEqual({ fresh: { k: 'v' } });

      releaseLoad();
      await manager.load();
      await flushPersist();

      expect(manager.getAll()).toEqual({ old: { b: 2 }, fresh: { k: 'v' } });
      expect(store.persisted).toEqual({ old: { b: 2 }, fresh: { k: 'v' } });
    });

    it('clearAll before the load wipes the persisted map', async () => {
      const { manager, store, releaseLoad } = makeManager({ old: { a: 1 } });
      manager.clearAll();
      releaseLoad();
      await manager.load();
      await flushPersist();

      expect(manager.getAll()).toEqual({});
      expect(store.persisted).toBeNull();
    });

    it('does not write storage at load when nothing changed before it', async () => {
      const { store } = await loaded({ p: { k: 1 } });
      await flushPersist();
      expect(store.saves).toBe(0);
    });

    it('persists after each change, ending on the latest map', async () => {
      const { manager, store } = await loaded();
      manager.setValue('p', 'k', 1);
      manager.setValue('p', 'k', 2);
      manager.setValue('q', 'k', 3);
      await flushPersist();

      expect(store.persisted).toEqual({ p: { k: 2 }, q: { k: 3 } });
    });

    it('an unreadable store is never overwritten: the launch stays in memory', async () => {
      let saves = 0;
      const manager = new ProviderContextManager({
        load: () => Promise.reject(new Error('storage busy')),
        save: async () => {
          saves++;
        },
      });
      manager.setValue('early', 'k', 1); // replayed at load
      await manager.load();
      manager.setValue('p', 'k', 1);
      await flushPersist();

      expect(manager.getAll()).toEqual({ early: { k: 1 }, p: { k: 1 } });
      expect(saves).toBe(0);
    });

    it('clearAll is saved even when the store could not be read, and saving resumes', async () => {
      const saves: ProviderContextMap[] = [];
      const manager = new ProviderContextManager({
        load: () => Promise.reject(new Error('storage busy')),
        save: async (map) => {
          saves.push(map);
        },
      });
      await manager.load();
      manager.setValue('p', 'k', 1);
      await flushPersist();
      expect(saves).toEqual([]); // a partial map never overwrites the store

      manager.clearAll();
      await flushPersist();
      manager.setValue('q', 'k', 2);
      await flushPersist();

      expect(saves).toEqual([{}, { q: { k: 2 } }]);
    });

    it('a clearAll made before an unreadable load is saved too', async () => {
      const saves: ProviderContextMap[] = [];
      const manager = new ProviderContextManager({
        load: () => Promise.reject(new Error('storage busy')),
        save: async (map) => {
          saves.push(map);
        },
      });
      manager.clearAll(); // memory already empty: still a write to the store
      manager.setValue('q', 'k', 2);
      await manager.load();
      await flushPersist();

      expect(saves).toEqual([{ q: { k: 2 } }]);
    });

    it('a load that throws mid-replay still finishes loading', async () => {
      const manager = new ProviderContextManager({
        // Not a map: Object.entries on a block throws during the replay.
        load: async () => ({ p: null }) as any,
        save: async () => {},
      });
      await expect(manager.load()).resolves.toBeUndefined();
      expect(manager.setValue('p', 'k', 1)).toBe(true);
    });

    it('a failed save warns and does not stop later saves', async () => {
      let fail = true;
      const saved: ProviderContextMap[] = [];
      const manager = new ProviderContextManager({
        load: async () => null,
        save: async (map) => {
          if (fail) {
            fail = false;
            throw new Error('disk full');
          }
          saved.push(map);
        },
      });
      await manager.load();
      manager.setValue('p', 'k', 1); // this save fails
      await flushPersist();
      manager.setValue('p', 'k', 2);
      await flushPersist();

      expect(saved).toEqual([{ p: { k: 2 } }]);
    });
  });
});

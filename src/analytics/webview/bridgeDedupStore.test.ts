import { BridgeDedupStore } from './bridgeDedupStore';

describe('BridgeDedupStore', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000;
  });

  it('reports a first sighting as new and a repeat within the TTL as a duplicate', () => {
    const store = new BridgeDedupStore(10, 1_000, clock);
    expect(store.markIfNew('a')).toBe(true);
    now += 999;
    expect(store.markIfNew('a')).toBe(false);
  });

  it('does not collide distinct ids', () => {
    const store = new BridgeDedupStore(10, 1_000, clock);
    expect(store.markIfNew('a')).toBe(true);
    expect(store.markIfNew('b')).toBe(true);
  });

  it('treats a sighting after the TTL, or exactly at it, as new', () => {
    const store = new BridgeDedupStore(10, 1_000, clock);
    store.markIfNew('a');
    now += 1_000;
    expect(store.markIfNew('a')).toBe(true);
  });

  it('does not refresh the window on a duplicate', () => {
    const store = new BridgeDedupStore(10, 1_000, clock);
    store.markIfNew('a');
    now += 600;
    expect(store.markIfNew('a')).toBe(false);
    now += 600; // 1200 after the first sighting, 600 after the duplicate
    expect(store.markIfNew('a')).toBe(true);
  });

  it('evicts the oldest entry when full and never exceeds the bound', () => {
    const store = new BridgeDedupStore(3, 60_000, clock);
    for (const id of ['a', 'b', 'c', 'd']) store.markIfNew(id);
    expect(store.size()).toBe(3);
    expect(store.markIfNew('a')).toBe(true); // evicted, so new again
    expect(store.markIfNew('d')).toBe(false);
  });

  it('moves an expired entry to the back of the eviction order on re-sighting', () => {
    const store = new BridgeDedupStore(2, 1_000, clock);
    store.markIfNew('a');
    now += 10;
    store.markIfNew('b');
    now += 1_000; // 'a' expired
    store.markIfNew('a'); // re-recorded, now newer than 'b'
    store.markIfNew('c'); // evicts 'b', not 'a'
    expect(store.markIfNew('a')).toBe(false);
    expect(store.markIfNew('b')).toBe(true);
  });

  it('forget removes an id', () => {
    const store = new BridgeDedupStore(10, 1_000, clock);
    store.markIfNew('a');
    store.forget('a');
    expect(store.markIfNew('a')).toBe(true);
  });

  it('rejects a zero bound or TTL', () => {
    expect(() => new BridgeDedupStore(0, 1_000, clock)).toThrow();
    expect(() => new BridgeDedupStore(10, 0, clock)).toThrow();
  });
});

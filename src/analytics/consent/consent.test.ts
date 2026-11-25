import {
  canonicalize,
  implicitDefault,
  reconcile,
  sameDecision,
  wireShape,
} from './consent';

const registry = [
  { key: 'c0001', defaultOptOut: false },
  { key: 'c0002', defaultOptOut: true },
  { key: 'c0004', defaultOptOut: true },
];

describe('reconcile', () => {
  it('passes everything through, canonicalized, with an empty registry', () => {
    const out = reconcile(
      { explicit: true, optOut: { ' C0001 ': true, 'x': false } },
      []
    );
    expect(out.optOut).toEqual({ c0001: true, x: false });
  });

  it('keeps known values, drops unknown keys, fills missing with defaults', () => {
    const out = reconcile(
      { explicit: true, optOut: { c0001: true, unknown: false } },
      registry
    );
    expect(out.optOut).toEqual({ c0001: true, c0002: true, c0004: true });
  });

  it('canonicalizes incoming keys before matching', () => {
    // OneTrust's native C0004 must not miss the lookup and fall to a default.
    const out = reconcile(
      { explicit: true, optOut: { C0001: true } },
      registry
    );
    expect(out.optOut.c0001).toBe(true);
  });

  it('keys colliding after canonicalization resolve opted out', () => {
    expect(
      Object.fromEntries(canonicalize({ C0004: false, c0004: true }))
    ).toEqual({ c0004: true });
    expect(
      Object.fromEntries(canonicalize({ c0004: true, C0004: false }))
    ).toEqual({ c0004: true });
  });

  it('passes explicit and timestamp through, and is idempotent', () => {
    const once = reconcile(
      { explicit: true, optOut: { c0001: false }, timestamp: 5 },
      registry
    );
    expect(once.explicit).toBe(true);
    expect(once.timestamp).toBe(5);
    expect(reconcile(once, registry)).toEqual(once);
  });

  it('returns frozen state', () => {
    const out = reconcile({ explicit: true, optOut: {} }, registry);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.optOut)).toBe(true);
  });
});

describe('implicitDefault', () => {
  it('is explicit false with registered defaults', () => {
    expect(implicitDefault(registry)).toEqual({
      explicit: false,
      optOut: { c0001: false, c0002: true, c0004: true },
    });
    expect(implicitDefault([])).toEqual({ explicit: false, optOut: {} });
  });
});

describe('sameDecision / wireShape', () => {
  it('ignores the timestamp', () => {
    expect(
      sameDecision(
        { explicit: true, optOut: { a: true }, timestamp: 1 },
        { explicit: true, optOut: { a: true }, timestamp: 2 }
      )
    ).toBe(true);
    expect(
      sameDecision(
        { explicit: true, optOut: { a: true } },
        { explicit: true, optOut: { a: false } }
      )
    ).toBe(false);
  });

  it('the wire shape never carries the timestamp', () => {
    expect(
      JSON.stringify(
        wireShape({ explicit: true, optOut: { a: true }, timestamp: 9 })
      )
    ).toBe('{"explicit":true,"optOut":{"a":true}}');
  });
});

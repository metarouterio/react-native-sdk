/**
 * Canonical consent state: what the host pushes in through `setConsent` and what
 * the SDK stores and stamps on outbound events. Field names and semantics are the
 * web SDK's `context.consent` block verbatim, so the server gates mobile and
 * browser traffic with one rule set — renaming a field here forks every
 * per-integration consent rule downstream.
 */
export interface Consent {
  /**
   * True when the state reflects an explicit end-user choice (a banner
   * interaction); false for an implicit or regional-default posture. Only the
   * host knows which CMP callback fired.
   */
  readonly explicit: boolean;
  /**
   * Flat category map with opt-OUT semantics: true means blocked. Keys are
   * lowercase category codes (`c0001`, `analytics`, …); keys passed to
   * `setConsent` are trimmed and lowercased, and if two collapse to one,
   * opted-out wins.
   */
  readonly optOut: Readonly<Record<string, boolean>>;
  /**
   * Epoch milliseconds of the snapshot, as the host's CMP records it. A
   * `setConsent` carrying a timestamp older than the newest host-supplied one
   * since the last `clearConsent` is ignored as a stale CMP replay. Leave it out
   * and the SDK stamps the device clock, for information only. Never sent.
   */
  readonly timestamp?: number;
}

/**
 * A consent category the host registers before any values arrive. A CMP payload
 * is sparse and vendor-shaped; the registry is what lets the SDK complete an
 * incoming snapshot into a full block: known keys keep their value, unknown keys
 * are dropped, missing categories take `defaultOptOut`.
 */
export interface ConsentCategory {
  /** Lowercase category code matching the keys in `Consent.optOut`. */
  readonly key: string;
  /**
   * Posture when an incoming snapshot does not mention this category. Defaults
   * to true (blocked): the absence of a signal never opts a user in.
   */
  readonly defaultOptOut?: boolean;
}

/** A registered category after normalization. */
export interface NormalizedCategory {
  readonly key: string;
  readonly defaultOptOut: boolean;
}

/**
 * Canonical form of an `optOut` key: trimmed and lowercased. The one definition
 * both the registry and every vendor adapter normalize through.
 */
export function canonicalKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Re-keys an `optOut` map canonically, dropping blank keys. Two raw keys that
 * collapse to one (`C0004` and `c0004`) resolve fail-closed — opted out wins —
 * because key order is not something a host controls, and a coin flip must
 * never be what opts a user in.
 */
export function canonicalize(
  optOut: Readonly<Record<string, boolean>>
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const [key, value] of Object.entries(optOut)) {
    const canonical = canonicalKey(key);
    if (canonical === '') continue;
    result.set(canonical, (result.get(canonical) ?? false) || value);
  }
  return result;
}

/** Same decision, ignoring the clock: subscribers react to decisions, not clocks. */
export function sameDecision(a: Consent, b: Consent): boolean {
  if (a.explicit !== b.explicit) return false;
  const aKeys = Object.keys(a.optOut);
  if (aKeys.length !== Object.keys(b.optOut).length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b.optOut, k) &&
      a.optOut[k] === b.optOut[k]
  );
}

/**
 * Every Consent the manager hands out is built here, frozen: the same object is
 * what enrichment stamps, and a host mutating `getConsent().optOut` must not
 * rewrite what every later event carries. fromEntries, not assignment, so a
 * category named "__proto__" is a key, not a prototype.
 */
function freeze(
  explicit: boolean,
  optOut: Iterable<[string, boolean]>,
  timestamp: number | undefined
): Consent {
  return Object.freeze({
    explicit,
    optOut: Object.freeze(Object.fromEntries(optOut)),
    ...(timestamp !== undefined && { timestamp }),
  });
}

/**
 * Completes an incoming snapshot against the registered categories. It never
 * gates delivery: events send regardless, and the server decides per
 * integration. An empty registry passes every value through — with nothing to
 * reconcile against, dropping keys would discard the host's signal.
 *
 * Incoming keys are canonicalized first, on both paths: the registry is
 * lowercase, so a host passing OneTrust's native `C0004` would otherwise miss
 * the lookup and get the registered default — silently dropping an opt-out
 * whenever that default is opt-in.
 */
export function reconcile(
  incoming: Consent,
  registry: readonly NormalizedCategory[]
): Consent {
  const optOut = canonicalize(incoming.optOut);
  if (registry.length === 0) {
    return freeze(incoming.explicit, optOut, incoming.timestamp);
  }
  return freeze(
    incoming.explicit,
    registry.map((c) => [c.key, optOut.get(c.key) ?? c.defaultOptOut]),
    incoming.timestamp
  );
}

/**
 * The state events carry before the host ever calls `setConsent`: not an
 * "unknown" marker but a real block — `explicit: false` with every registered
 * category at its default — so the server gates it exactly like an
 * implicit-consent web visitor.
 */
export function implicitDefault(
  registry: readonly NormalizedCategory[]
): Consent {
  return freeze(
    false,
    registry.map((c) => [c.key, c.defaultOptOut]),
    undefined
  );
}

/** The block as stamped and as getDebugInfo reports it: no timestamp. */
export function wireShape(consent: Consent): {
  explicit: boolean;
  optOut: Readonly<Record<string, boolean>>;
} {
  // Frozen: one instance is shared by every event and getDebugInfo until the
  // decision changes, so a host mutating one must not rewrite the others.
  return Object.freeze({ explicit: consent.explicit, optOut: consent.optOut });
}

import { warn } from '../utils/logger';
import { buildConfig } from '../utils/buildConfig';
import { isRecord } from '../utils/isRecord';
import {
  canonicalKey,
  implicitDefault,
  reconcile,
  sameDecision,
  wireShape,
  type Consent,
  type ConsentCategory,
  type NormalizedCategory,
} from './consent';
import {
  loadConsent,
  loadConsentSync,
  saveConsent,
  type StoredConsent,
} from './consentStorage';

/**
 * A host timestamp past this is not epoch milliseconds — micro- or nanoseconds
 * (~1.7e15+) — and would reject every later real timestamp until the next
 * clearConsent; it is applied as untimestamped instead, with a warning. A fixed
 * date, not the device clock, which the staleness rule never consults. Seconds
 * are not caught: a host that sends one millisecond timestamp and then seconds
 * has every seconds call rejected until it clears. Use one unit.
 */
export const MAX_PLAUSIBLE_HOST_TIMESTAMP = 4_102_444_800_000; // 2100-01-01

/**
 * One host write, recorded before the stored state has loaded. `consent`
 * already carries the device-clock stamp of an untimestamped call;
 * `hostTimestamp` is what the staleness rule compares. Null is a clear.
 */
type Write = { consent: Consent; hostTimestamp?: number } | null;

/**
 * Null once unsubscribed, checked again at delivery: unsubscribing also drops
 * deliveries already queued, so a component that unsubscribes in its cleanup
 * never gets one more callback.
 */
type Subscription = { handler: ((consent: Consent) => void) | null };

/**
 * Owns the consent state machine: the category registry, the reconciled view,
 * persistence, and change subscriptions. The public API delegates here;
 * enrichment reads `getConsent()` per event.
 *
 * Process-wide, like provider context: usable before `createAnalyticsClient`
 * (CMP callbacks fire whenever they fire) and untouched by `reset()`. Writes are
 * synchronous in memory — a host that calls setConsent and tracks on the next
 * line expects that event to carry the new state — and persist in the
 * background.
 *
 * `load()` reads the stored state synchronously from native storage, so the
 * user's decision is in memory before host code runs, as on iOS and Android.
 * Without the native module it comes from AsyncStorage and arrives later: until
 * then reads report the implicit default plus this launch's writes, which are
 * recorded, and the load replays them over the stored state through the same
 * staleness rule — the outcome had storage been there from the start, as
 * Android's attachStorage does. Client init awaits `load()`. An unreadable store
 * makes the launch memory-only rather than overwrite a decision it could not
 * read, until a clear: that is saved, and saving resumes after it.
 *
 * Subscriber callbacks are queued (a microtask), never run inline: a handler
 * that calls back into the manager must not re-enter a commit, and queue order
 * is commit order.
 */
export class ConsentManager {
  private registry: NormalizedCategory[] = [];
  // Recomputed only when the registry changes: getConsent() is on the per-event
  // enrichment path.
  private implicit: Consent = implicitDefault([]);
  /** Null = never set (or cleared). */
  private stored: StoredConsent | null = null;
  /** `stored` projected onto `registry`. */
  private reconciled: Consent | null = null;
  /** The visible state as stamped; rebuilt on change, not per event. */
  private wire = wireShape(this.implicit);
  private readonly subscribers = new Set<Subscription>();
  private warnedEmptyRegistry = false;

  private loaded = false;
  private loading: Promise<void> | null = null;
  private preLoadWrites: Write[] = [];
  // Set when the stored state could not be read: it may be intact, and saving
  // over it would replace the user's decision. Cleared by clearConsent, which
  // needs no knowledge of the stored state.
  private persistDisabled = false;
  private savePending = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: {
      /** Undefined when the state is only available through `load`. */
      loadSync?: () => StoredConsent | null | undefined;
      load: () => Promise<StoredConsent | null>;
      save: (stored: StoredConsent | null) => Promise<void>;
    } = {
      loadSync: loadConsentSync,
      load: () => loadConsent(),
      save: saveConsent,
    },
    private readonly clockMillis: () => number = Date.now,
    private readonly dispatch: (work: () => void) => void = (work) => {
      Promise.resolve().then(work);
    },
    private readonly failFast: () => boolean = () =>
      buildConfig.isDevelopmentBuild()
  ) {}

  private visible(): Consent {
    return this.reconciled ?? this.implicit;
  }

  // ===== Registry =====

  /**
   * Replaces (not merges) the registered set and recomputes the view of any
   * stored consent against it, so a snapshot stored by a build with fewer
   * categories still reaches the server as a complete block.
   *
   * Misconfigured input degrades instead of throwing in release: keys are
   * trimmed and lowercased, blank keys dropped, duplicates keep the first
   * occurrence, each with a warning. A development build throws instead, like
   * the native debug-build fail-fast — a typo here otherwise surfaces as a
   * category that silently never matches.
   */
  registerConsentCategories(categories: readonly ConsentCategory[]): void {
    const problems: string[] = [];
    let normalized: NormalizedCategory[] | null;
    try {
      normalized = normalizeCategories(categories, problems);
    } catch (err) {
      // Input that throws on read (a getter, a Proxy) must not crash a release
      // host; a development build gets the throw, like any registration problem.
      if (this.failFast()) throw err;
      warn(
        'registerConsentCategories: categories could not be read — ignored',
        err
      );
      return;
    }
    if (problems.length > 0) {
      if (this.failFast()) throw new Error(problems.join('; '));
      problems.forEach((p) => warn(p));
    }
    // Not an array (a config not loaded yet): keep the registry, as unreadable
    // input does, rather than wipe every category's default from the wire.
    if (normalized === null) return;
    const before = this.visible();
    this.registry = normalized;
    this.implicit = implicitDefault(normalized);
    this.reconciled = this.stored
      ? reconcile(this.stored.consent, normalized)
      : null;
    this.notifyIfChanged(before);
  }

  // ===== State =====

  /**
   * Current consent. Never null: before the first setConsent (and after
   * clearConsent) the implicit default — `explicit: false`, registered
   * categories at their defaults.
   */
  getConsent(): Consent {
    return this.visible();
  }

  /** `getConsent()` in the stamped shape, cached for the per-event path. */
  getWireConsent(): ReturnType<typeof wireShape> {
    return this.wire;
  }

  /**
   * Reconciles, stores, persists, and notifies. Fully replaces prior state.
   *
   * @returns false when ignored: malformed input, or a host timestamp older
   *   than the newest host timestamp since the last clearConsent (a CMP
   *   replaying a cached choice must not overwrite the one the user just made).
   *   Before the stored state loads (only without the native module), true is
   *   provisional: the call is checked against memory only, and the replay at
   *   load drops it, with a warning, when its timestamp is older than the
   *   newest stored host timestamp.
   *   Untimestamped calls are never compared with any timestamp: the device
   *   clock and the CMP's clock disagree and jump, so such a call is applied as
   *   the user's choice as of now.
   */
  setConsent(input: unknown): boolean {
    let consent: Consent | null;
    try {
      consent = sanitize(input);
    } catch (err) {
      // Input that throws on read (a getter, a Proxy) must not crash the host.
      warn('setConsent: consent could not be read — ignored', err);
      return false;
    }
    if (!consent) return false;

    const hostTimestamp = consent.timestamp;
    const write: Write =
      hostTimestamp !== undefined
        ? { consent, hostTimestamp }
        : {
            consent: { ...consent, timestamp: this.clockMillis() },
          };

    const next = applied(write, this.stored);
    if (!next) return false;
    if (!this.loaded) this.preLoadWrites.push(write);

    if (this.registry.length === 0 && !this.warnedEmptyRegistry) {
      // Once per process: a host that never registers would otherwise log on
      // every CMP callback.
      this.warnedEmptyRegistry = true;
      warn(
        'setConsent: no categories registered — optOut sent unreconciled until registerConsentCategories.'
      );
    }
    this.commit(next);
    if (this.loaded) this.persist();
    return true;
  }

  /**
   * Wipes memory and storage, watermark included, returning to the implicit
   * default. Distinct from `reset()`, which leaves consent alone. The watermark
   * goes too: keeping it rejected the CMP re-pushing its cached choice after a
   * logout clear, and with an opt-in-default category that left a user who
   * rejected everything opted in.
   */
  clearConsent(): void {
    if (!this.loaded) {
      // Everything before a clear is moot to the replay.
      this.preLoadWrites = [null];
    }
    this.commit(null);
    if (this.loaded) {
      // Saved even when the stored state could not be read: removing it needs
      // no knowledge of it, and a withdrawal must stick.
      this.persistDisabled = false;
      this.persist();
    }
  }

  private commit(next: StoredConsent | null): void {
    const before = this.visible();
    // Reconciled first: if it throws, nothing changed.
    const reconciled = next ? reconcile(next.consent, this.registry) : null;
    this.stored = next;
    this.reconciled = reconciled;
    this.notifyIfChanged(before);
  }

  private persist(): void {
    if (this.persistDisabled || this.savePending) return;
    this.savePending = true;
    this.persistChain = this.persistChain
      .then(() => {
        // Cleared before the save reads the state: a commit landing while this
        // save is in flight queues the next one.
        this.savePending = false;
        return this.storage.save(this.stored);
      })
      .catch((err) => warn('Consent could not be persisted', err));
  }

  // ===== Load =====

  /**
   * Loads the stored state once and replays the writes made before it. Always
   * resolves: client init awaits it. Subscribers hear the result if it differs
   * from what they last saw.
   */
  load(): Promise<void> {
    if (!this.loading) {
      let loaded: StoredConsent | null | undefined;
      try {
        loaded = this.storage.loadSync?.();
      } catch (err) {
        loaded = this.unreadable(err);
      }
      this.loading =
        loaded !== undefined
          ? Promise.resolve(this.settle(loaded))
          : this.storage
              .load()
              .catch((err) => this.unreadable(err))
              .then((stored) => this.settle(stored));
    }
    return this.loading;
  }

  private unreadable(err: unknown): null {
    this.persistDisabled = true;
    warn(
      'Consent storage unreadable — consent applies in memory this launch; the stored state is left untouched.',
      err
    );
    return null;
  }

  private settle(loaded: StoredConsent | null): void {
    try {
      this.applyLoaded(loaded);
    } catch (err) {
      // Last resort for the always-resolves contract. A throw after the load
      // completed leaves saving as it was.
      if (!this.loaded) {
        this.persistDisabled = true;
        this.loaded = true;
      }
      warn('Consent state could not be loaded', err);
    }
  }

  private applyLoaded(loaded: StoredConsent | null): void {
    const writes = this.preLoadWrites;
    this.preLoadWrites = [];
    let replayed = loaded;
    for (const write of writes) {
      replayed = write === null ? null : (applied(write, replayed) ?? replayed);
    }
    this.commit(replayed);
    this.loaded = true;
    if (writes.length === 0) return;
    // A clear made before an unreadable load still reaches storage, and
    // everything after it was applied over nothing, so memory is again what
    // storage should hold.
    if (writes.includes(null)) this.persistDisabled = false;
    this.persist();
  }

  // ===== Subscriptions =====

  /**
   * Registers a change handler and queues one delivery of the current value — a
   * late subscriber must not have to guess whether consent already arrived.
   * Then fires on every real change, never on a value-identical setConsent.
   *
   * @returns an unsubscribe function; idempotent. After it returns, the handler
   *   is not invoked again, even for a delivery already queued. Keep it: the
   *   manager is process-wide, so a dropped one delivers for the life of the app.
   */
  subscribe(handler: (consent: Consent) => void): () => void {
    const subscription: Subscription = { handler };
    this.subscribers.add(subscription);
    this.deliver(this.visible(), subscription);
    return () => {
      subscription.handler = null;
      this.subscribers.delete(subscription);
    };
  }

  /** Fires only when what readers see changed: decisions, not clocks. */
  private notifyIfChanged(before: Consent): void {
    const after = this.visible();
    if (sameDecision(after, before)) return;
    this.wire = wireShape(after);
    for (const subscription of this.subscribers) {
      this.deliver(after, subscription);
    }
  }

  private deliver(consent: Consent, subscription: Subscription): void {
    this.dispatch(() => {
      const handler = subscription.handler;
      if (!handler) return;
      try {
        handler(consent);
      } catch (err) {
        // One throwing handler must not stop delivery to the others.
        warn('Consent subscriber threw', err);
      }
    });
  }
}

/**
 * The write applied over `current`, or null when stale: its host timestamp is
 * older than the watermark. An untimestamped write carries the watermark
 * forward. Only strictly older is stale: an equal timestamp is the same moment.
 */
function applied(
  write: Exclude<Write, null>,
  current: StoredConsent | null
): StoredConsent | null {
  const watermark = current?.lastHostTimestamp;
  if (write.hostTimestamp === undefined) {
    return {
      consent: write.consent,
      ...(watermark !== undefined && { lastHostTimestamp: watermark }),
    };
  }
  if (watermark !== undefined && write.hostTimestamp < watermark) {
    warn(
      `setConsent ignored: snapshot (${write.hostTimestamp}) is older than the newest host-timestamped state (${watermark})`
    );
    return null;
  }
  return { consent: write.consent, lastHostTimestamp: write.hostTimestamp };
}

/**
 * The host's input as a Consent the manager owns, or null (with a warning) when
 * it is not one. The native type systems guarantee the shape; a JS host can pass
 * anything. Copied, so a host mutating its object later cannot change what the
 * next registration reconciles. A non-boolean optOut value counts as opted out:
 * an unreadable signal never opts a user in.
 */
function sanitize(input: unknown): Consent | null {
  if (!isRecord(input)) {
    warn('setConsent: expected { explicit, optOut, timestamp? } — ignored');
    return null;
  }
  // Each field read once: a getter must not answer the check and the use
  // differently.
  const { explicit, optOut: rawOptOut, timestamp } = input;
  if (!isRecord(rawOptOut) || !isPlainObject(rawOptOut)) {
    warn('setConsent: expected { explicit, optOut, timestamp? } — ignored');
    return null;
  }
  if (typeof explicit !== 'boolean') {
    warn('setConsent: explicit is not a boolean — treated as false');
  }
  const optOut: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(rawOptOut)) {
    if (typeof value !== 'boolean') {
      warn(
        `setConsent: optOut["${key}"] is not a boolean — treated as opted out`
      );
    }
    Object.defineProperty(optOut, key, {
      value: value !== false,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const hostTimestamp = hostTimestampOf(timestamp);
  return {
    explicit: explicit === true,
    optOut,
    ...(hostTimestamp !== undefined && { timestamp: hostTimestamp }),
  };
}

/**
 * Only a plain object is read as an optOut map. Anything else — a Map, a Promise
 * the host forgot to await, a class instance — would be read by its own
 * enumerable properties, usually none, and every registered default would stand
 * in for the user's decision. Rejected instead: the call returns false with a
 * warning, and the previous state stays.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The host timestamp the staleness rule may compare, or undefined to apply the
 * call as untimestamped. The one place that decides it. Unusable values are
 * applied untimestamped, never rejected: rejecting would also drop a real
 * opt-out, and a withdrawal must apply. A string of digits is accepted, since a
 * CMP bridge serializing its timestamps would otherwise skip the staleness
 * check on every call.
 */
function hostTimestampOf(timestamp: unknown): number | undefined {
  if (timestamp === undefined || timestamp === null) return undefined;
  const value =
    typeof timestamp === 'string' && /^\d+$/.test(timestamp.trim())
      ? Number(timestamp.trim())
      : timestamp;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warn(
      'setConsent: timestamp is not a finite number of epoch milliseconds — applied as untimestamped'
    );
    return undefined;
  }
  if (value > MAX_PLAUSIBLE_HOST_TIMESTAMP) {
    warn(
      `setConsent: timestamp ${value} is not epoch milliseconds — applied as untimestamped`
    );
    return undefined;
  }
  return value;
}

function normalizeCategories(
  categories: readonly ConsentCategory[],
  problems: string[]
): NormalizedCategory[] | null {
  if (!Array.isArray(categories)) {
    problems.push(
      'registerConsentCategories: expected an array of { key, defaultOptOut? } — registry left unchanged'
    );
    return null;
  }
  const seen = new Set<string>();
  const result: NormalizedCategory[] = [];
  for (const category of categories) {
    if (!isRecord(category)) {
      problems.push(
        'registerConsentCategories: entry without a string key dropped'
      );
      continue;
    }
    // Each field read once: a getter must not answer the check and the use
    // differently.
    const { key: rawKey, defaultOptOut } = category;
    if (typeof rawKey !== 'string') {
      problems.push(
        'registerConsentCategories: entry without a string key dropped'
      );
      continue;
    }
    const key = canonicalKey(rawKey);
    if (key === '') {
      problems.push('registerConsentCategories: blank category key dropped');
      continue;
    }
    if (key !== rawKey) {
      problems.push(
        `registerConsentCategories: key "${rawKey}" normalized to "${key}" — optOut keys are lowercase and matched exactly`
      );
    }
    if (seen.has(key)) {
      problems.push(
        `registerConsentCategories: duplicate key "${key}" — keeping the first occurrence`
      );
      continue;
    }
    seen.add(key);
    if (defaultOptOut !== undefined && typeof defaultOptOut !== 'boolean') {
      // A string "false" meaning opt-in would otherwise ship blocked silently.
      problems.push(
        `registerConsentCategories: defaultOptOut for "${key}" is not a boolean — treated as true (blocked)`
      );
    }
    result.push({ key, defaultOptOut: defaultOptOut !== false });
  }
  return result;
}

let processManager: ConsentManager | null = null;

/**
 * The process-wide manager every client and the pre-init proxy share. Its load
 * starts on first use — when the SDK module loads (init.ts).
 */
export function getProcessConsentManager(): ConsentManager {
  if (!processManager) {
    processManager = new ConsentManager();
    void processManager.load();
  }
  return processManager;
}

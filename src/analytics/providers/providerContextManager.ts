import { warn } from '../utils/logger';
import { utf8ByteLength } from '../utils/utf8';
import {
  loadProviderContext,
  loadProviderContextSync,
  saveProviderContext,
  type JsonValue,
  type ProviderContextMap,
} from './providerContextStorage';

/**
 * Reserved for the SDK's own block (`sessionID`, `sessionCount`). Enrichment
 * writes it last and would win anyway, but a write that silently vanished later
 * is worse than one rejected at the call. Matched ignoring case and separators,
 * so `Metarouter` or `meta_router` cannot sit beside it looking like ours.
 */
export const RESERVED_PROVIDER = 'metarouter';

// This map rides on EVERY event, so the bound that matters is its total size,
// not how many providers or keys it holds: hybrid apps forward ~20 sync
// providers, and a count cap rejects them while a few large values pass.
// 16 KiB total sits well under the cluster's single-event cap (250 KiB), even
// beside a 64 KiB bridge payload.
//
// 2 KiB per value fits an encrypted enrichment envelope (always over 256 B) and
// stops one key from taking the whole budget. Exceeding a bound rejects that
// one write and keeps prior state; it never trims, because a truncated vendor
// id looks valid and matches nothing.
//
// A rejection warns and returns false — never throws, even in __DEV__. Values
// here come from third-party SDKs the host does not control, and a throw would
// crash the host on vendor data. All limits count UTF-8 bytes of encoded JSON.
export const MAX_VALUE_BYTES = 2 * 1024;
export const MAX_TOTAL_BYTES = 16 * 1024;
export const MAX_NAME_BYTES = 64;

/** One host write, as recorded before the persisted map has loaded. */
type Write =
  /** `value` undefined removes the key. */
  | { kind: 'put'; provider: string; key: string; value: JsonValue | undefined }
  | { kind: 'clearProvider'; provider: string }
  | { kind: 'clearAll' };

type Outcome = 'rejected' | 'unchanged' | 'changed';

const INVALID = Symbol('invalid');

/**
 * Converts a host value to JSON, or INVALID. Lenient conversion would store a
 * value the host never set (`{ id: 'abc', ts: new Date() }` stamping the date's
 * string on every event; `undefined` silently dropped by JSON.stringify), so
 * anything unrepresentable anywhere — a non-finite number, undefined, a
 * function, a class instance, a cycle — rejects the whole write. The result is
 * a fresh, frozen copy: a host mutating its object afterwards cannot rewrite
 * what every event is stamped from.
 */
function strictlyConverted(
  value: unknown,
  ancestors: Set<object>
): JsonValue | typeof INVALID {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : INVALID;
    case 'object':
      break;
    default:
      return INVALID; // undefined, function, symbol, bigint
  }
  if (value === null) return null;
  if (ancestors.has(value)) return INVALID;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (let i = 0; i < value.length; i++) {
        // A hole encodes as null, a value the host never set.
        if (!(i in value)) return INVALID;
        const item = strictlyConverted(value[i], ancestors);
        if (item === INVALID) return INVALID;
        out.push(item);
      }
      return Object.freeze(out) as JsonValue[];
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return INVALID;
    if (Object.getOwnPropertySymbols(value).length > 0) return INVALID;
    const entries: [string, JsonValue][] = [];
    for (const [k, v] of Object.entries(value)) {
      const item = strictlyConverted(v, ancestors);
      if (item === INVALID) return INVALID;
      entries.push([k, item]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

/** Freezes a value read back from storage, as set-time conversion does. */
function deepFreeze(value: JsonValue): JsonValue {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Unicode letters and numbers per code point, as Android's `isLetterOrDigit`
 * sees them (iOS judges whole graphemes, so a combining mark after a letter
 * differs there) — when the engine has Unicode property escapes. Probed
 * rather than assumed: an engine without them either throws on the pattern or
 * reads `\p` as a literal `p`, which the probe's `{` and `中` checks catch.
 */
const UNICODE_ALNUM: RegExp | null = (() => {
  try {
    const re = new RegExp('^[\\p{L}\\p{N}]$', 'u');
    return re.test('中') && re.test('١') && !re.test('{') && !re.test('_')
      ? re
      : null;
  } catch {
    return null;
  }
})();

/**
 * Lowercased and stripped of everything but letters and digits, as the native
 * SDKs do. Without Unicode property escapes (Hermes before React Native 0.74),
 * a non-ASCII character counts as a letter only when it has case; an uncased
 * one (CJK, non-Latin digits) is then dropped like a separator. That fallback
 * can only reserve a few more names than native, never fewer.
 */
function isReserved(providerName: string): boolean {
  let letters = '';
  for (const ch of providerName.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) letters += ch;
    else if (ch.charCodeAt(0) < 0x80) continue;
    else if (
      UNICODE_ALNUM
        ? UNICODE_ALNUM.test(ch)
        : ch.toLowerCase() !== ch.toUpperCase()
    )
      letters += ch;
  }
  return letters === RESERVED_PROVIDER;
}

function validName(name: string, label: string): boolean {
  if (name === '') {
    warn(`setProviderContext: blank ${label} name — ignored`);
    return false;
  }
  // UTF-8 bytes, not characters: the budget is a byte budget, and one grapheme
  // can carry hundreds of combining marks.
  if (utf8ByteLength(name) > MAX_NAME_BYTES) {
    warn(
      `setProviderContext: ${label} name exceeds ${MAX_NAME_BYTES} bytes — ignored`
    );
    return false;
  }
  return true;
}

// Maps, not objects, internally: a provider or key named "__proto__" would
// otherwise replace an object's prototype instead of becoming an entry.
type Providers = Map<string, Map<string, JsonValue>>;

/** The whole map as stamped, frozen. fromEntries defines own keys, "__proto__" included. */
function toSnapshot(providers: Providers): Readonly<ProviderContextMap> {
  return Object.freeze(
    Object.fromEntries(
      [...providers].map(([p, keys]) => [
        p,
        Object.freeze(Object.fromEntries(keys)),
      ])
    )
  );
}

/** Encoded bytes of a snapshot; names count, they are on the wire too. */
function encodedSize(snapshot: Readonly<ProviderContextMap>): number {
  return utf8ByteLength(JSON.stringify(snapshot));
}

/**
 * Owns the host-set `context.providers` map: in-memory state, bounds,
 * persistence. The public API delegates here; enrichment reads `getAll()` once
 * per event.
 *
 * Process-wide, not per client: it is usable before `createAnalyticsClient`
 * (a vendor id often resolves first) and outlives `reset()`. Writes apply in
 * memory at once — a host that resolves a vendor id and tracks on the next line
 * expects that event to carry it — and persist in the background.
 *
 * `load()` reads the persisted map synchronously from native storage, so it
 * is in memory before host code runs, as on iOS and Android. Without the native
 * module it comes from AsyncStorage and arrives later: until then the manager
 * runs in memory and records the writes made meanwhile, and the load replays
 * them over the persisted map, in order and through the same bounds, so the
 * result is what storage read at startup would have held. Client init awaits
 * `load()`, so last launch's values are on the cold-launch events.
 */
export class ProviderContextManager {
  private providers: Providers = new Map();
  /** Immutable view handed to enrichment; rebuilt per commit, not per event. */
  private snapshot: Readonly<ProviderContextMap> = Object.freeze({});
  /**
   * Encoded size of `snapshot`, so a put measures only its candidate. Null
   * until a put needs it: removals only shrink the map.
   */
  private snapshotBytes: number | null = 2;
  /** Whether the load has run; until then writes are recorded for replay. */
  private loaded = false;
  private loading: Promise<void> | null = null;
  private preLoadWrites: Write[] = [];
  // Set when the stored map could not be read or taken in: it may be intact,
  // and saving this launch's map over it would delete every vendor id stored
  // earlier. This launch then runs in memory; the next one reads it again.
  private persistDisabled = false;
  // Saves run one at a time and each writes the latest snapshot, so disk always
  // ends on the map memory holds; a burst of commits queues one save, not one
  // per commit.
  private persistChain: Promise<void> = Promise.resolve();
  private savePending = false;

  constructor(
    private readonly storage: {
      /** Undefined when the map is only available through `load`. */
      loadSync?: () => ProviderContextMap | null | undefined;
      load: () => Promise<ProviderContextMap | null>;
      save: (map: ProviderContextMap) => Promise<void>;
    } = {
      loadSync: loadProviderContextSync,
      load: () => loadProviderContext(),
      save: saveProviderContext,
    }
  ) {}

  // ===== Reads =====

  /** The full map, for enrichment and `getProviderContext()`. Frozen. */
  getAll(): Readonly<ProviderContextMap> {
    return this.snapshot;
  }

  /**
   * Provider → key names. Values omitted on purpose: these are vendor device
   * identifiers and getDebugInfo is printed into host logs — the same reason
   * the write key is masked there. The shape is what shows a misconfiguration.
   */
  toDebugInfo(): Record<string, string[]> {
    return Object.fromEntries(
      [...this.providers].map(([p, keys]) => [p, [...keys.keys()].sort()])
    );
  }

  // ===== Writes =====

  /**
   * Host entry point. `null` or `undefined` removes the key rather than
   * stamping a null: a mapping gets nothing useful from a null, and a host
   * passing one means "stop sending this".
   *
   * @returns false when the write was rejected (with a warning) and prior state
   *   stands; true when the state now reflects the call, including the removal
   *   of a key that was not set.
   */
  setValue(provider: string, key: string, value: unknown): boolean {
    // Never throws, as on native: a getter that throws, nesting deep enough to
    // overflow the stack, or a host passing a Symbol name all end here.
    try {
      return this.setValueOrThrow(provider, key, value);
    } catch (err) {
      warn('setProviderContext: write failed — ignored', err);
      return false;
    }
  }

  private setValueOrThrow(
    provider: string,
    key: string,
    value: unknown
  ): boolean {
    // Native signatures take non-null strings. String(undefined) would stamp a
    // provider literally named "undefined" that no mapping reads.
    if (typeof provider !== 'string' || typeof key !== 'string') {
      warn('setProviderContext: provider and key must be strings — ignored');
      return false;
    }
    let converted: JsonValue | undefined;
    if (value !== null && value !== undefined) {
      const result = strictlyConverted(value, new Set());
      if (result === INVALID) {
        warn(
          `setProviderContext("${provider}", key: "${key}"): value is not JSON-representable — ignored`
        );
        return false;
      }
      converted = result;
    }
    const providerName = provider.trim();
    const keyName = key.trim();

    // NOT lowercased, unlike consent category keys: these are wire paths
    // matched verbatim by pipeline mappings (the Firebase kit reads
    // `context.providers.googleFirebase.appInstanceId`), so canonicalising case
    // would break the mapping this exists to feed.
    if (!validName(providerName, 'provider') || !validName(keyName, 'key'))
      return false;

    if (isReserved(providerName)) {
      warn(
        `setProviderContext: "${providerName}" is reserved for the SDK's own session block — ignored`
      );
      return false;
    }

    if (converted !== undefined) {
      const byteCount = utf8ByteLength(JSON.stringify(converted));
      if (byteCount > MAX_VALUE_BYTES) {
        warn(
          `setProviderContext("${providerName}", key: "${keyName}"): value is ${byteCount} bytes, limit ${MAX_VALUE_BYTES} — ignored`
        );
        return false;
      }
    }

    return this.write({
      kind: 'put',
      provider: providerName,
      key: keyName,
      value: converted,
    });
  }

  /** Removes one provider's whole block. */
  clear(provider: string): void {
    if (typeof provider !== 'string') {
      warn('clearProviderContext: provider must be a string — ignored');
      return;
    }
    this.write({ kind: 'clearProvider', provider: provider.trim() });
  }

  /**
   * Removes everything the host has set. Distinct from `reset()`, which clears
   * identity and leaves this alone.
   */
  clearAll(): void {
    this.write({ kind: 'clearAll' });
  }

  private write(write: Write): boolean {
    const outcome = this.apply(write);
    if (outcome === 'rejected') return false;
    // Before the load every accepted write is recorded, no-ops included: a
    // clear or removal that finds nothing in memory may still have persisted
    // state to remove once it loads.
    if (!this.loaded) {
      this.preLoadWrites.push(write);
      return true;
    }
    if (write.kind === 'clearAll' && this.persistDisabled) {
      // Clearing everything needs no knowledge of the stored map, so it is
      // saved even when that map could not be read — otherwise a logout's clear
      // would be undone by the next launch's load. Memory now holds exactly
      // what storage should, so saving resumes. Saved even when memory was
      // already empty: the stored map may not be.
      this.persistDisabled = false;
      this.persist();
    } else if (outcome === 'changed') {
      this.persist();
    }
    return true;
  }

  /**
   * The one mutation path, for host writes and the replay at load alike.
   * Removing a provider's last key removes the provider — an empty block would
   * otherwise ship on every event forever, indistinguishable from a
   * misconfigured one.
   */
  private apply(write: Write): Outcome {
    switch (write.kind) {
      case 'put': {
        const existing = this.providers.get(write.provider);
        if (write.value !== undefined) {
          const candidate: Providers = new Map(this.providers);
          candidate.set(
            write.provider,
            new Map(existing ?? []).set(write.key, write.value)
          );
          const snapshot = toSnapshot(candidate);
          const byteCount = encodedSize(snapshot);
          // Over budget is still accepted when the map does not grow, as on
          // native, where a map persisted under the old count caps can exceed
          // it and the host must be able to shrink it a value at a time.
          if (this.snapshotBytes === null) {
            this.snapshotBytes = encodedSize(this.snapshot);
          }
          if (byteCount > MAX_TOTAL_BYTES && byteCount > this.snapshotBytes) {
            warn(
              `setProviderContext("${write.provider}", key: "${write.key}"): provider context would be ${byteCount} bytes, total limit ${MAX_TOTAL_BYTES} — ignored, prior values kept`
            );
            return 'rejected';
          }
          this.commit(candidate, snapshot, byteCount);
          return 'changed';
        }
        if (!existing?.has(write.key)) return 'unchanged';
        const keys = new Map(existing);
        keys.delete(write.key);
        const next = new Map(this.providers);
        if (keys.size === 0) next.delete(write.provider);
        else next.set(write.provider, keys);
        this.commit(next);
        return 'changed';
      }
      case 'clearProvider': {
        if (!this.providers.has(write.provider)) return 'unchanged';
        const next = new Map(this.providers);
        next.delete(write.provider);
        this.commit(next);
        return 'changed';
      }
      case 'clearAll':
        if (this.providers.size === 0) return 'unchanged';
        this.commit(new Map());
        return 'changed';
    }
  }

  /** Installs a new map and its snapshot; the put path hands in the ones it measured. */
  private commit(
    providers: Providers,
    snapshot = toSnapshot(providers),
    bytes: number | null = null
  ): void {
    this.providers = providers;
    this.snapshot = snapshot;
    this.snapshotBytes = bytes;
  }

  private persist(): void {
    if (this.persistDisabled || this.savePending) return;
    this.savePending = true;
    this.persistChain = this.persistChain
      .then(() => {
        // Cleared before the save reads the snapshot: a commit landing while
        // this save is in flight queues the next one.
        this.savePending = false;
        return this.storage.save(this.snapshot);
      })
      .catch((err) => {
        warn('Provider context could not be persisted', err);
      });
  }

  // ===== Load =====

  /**
   * Loads the persisted map once and replays the writes made before it. Later
   * calls return the same promise, which always resolves — client init awaits
   * it, and an unreadable store must not stop the SDK. The manager outlives
   * clients, so a client built after `reset()` finds it loaded.
   */
  load(): Promise<void> {
    if (!this.loading) {
      let persisted: ProviderContextMap | null | undefined;
      try {
        persisted = this.storage.loadSync?.();
      } catch (err) {
        persisted = this.unreadable(err);
      }
      this.loading =
        persisted !== undefined
          ? Promise.resolve(this.settle(persisted))
          : this.storage
              .load()
              .catch((err) => this.unreadable(err))
              .then((map) => this.settle(map));
    }
    return this.loading;
  }

  private unreadable(err: unknown): null {
    this.persistDisabled = true;
    warn(
      'Provider context storage unreadable — values apply in memory this launch; stored values left untouched.',
      err
    );
    return null;
  }

  private settle(persisted: ProviderContextMap | null): void {
    try {
      this.applyLoaded(persisted);
    } catch (err) {
      // Last resort for the always-resolves contract. A throw after the load
      // completed leaves saving as it was.
      if (!this.loaded) {
        this.persistDisabled = true;
        this.loaded = true;
      }
      warn('Provider context could not be loaded', err);
    }
  }

  private applyLoaded(persisted: ProviderContextMap | null): void {
    let base: Providers;
    try {
      base = new Map(
        Object.entries(persisted ?? {}).map(([p, keys]) => [
          p,
          new Map(Object.entries(keys).map(([k, v]) => [k, deepFreeze(v)])),
        ])
      );
    } catch (err) {
      // Same as unreadable: never save over a stored map we could not take in.
      this.persistDisabled = true;
      warn('Stored provider context could not be loaded — left untouched', err);
      base = new Map();
    }
    const writes = this.preLoadWrites;
    this.preLoadWrites = [];
    this.commit(base);
    // One failing write must not drop the ones after it.
    for (const write of writes) {
      try {
        this.apply(write);
      } catch (err) {
        warn('Provider context write could not be replayed — skipped', err);
      }
    }
    this.loaded = true;
    // A clear made before an unreadable load still reaches storage (see
    // write()); everything after it was applied over an empty map, so memory
    // is again what storage should hold.
    if (this.persistDisabled && writes.some((w) => w.kind === 'clearAll')) {
      this.persistDisabled = false;
    }
    if (writes.length > 0) this.persist();
  }
}

let processManager: ProviderContextManager | null = null;

/**
 * The process-wide manager every client and the pre-init proxy share. It loads
 * on first use — when the SDK module loads (init.ts) — so the stored map is in
 * memory before the host's first read (later, without the native module).
 */
export function getProcessProviderContextManager(): ProviderContextManager {
  if (!processManager) {
    processManager = new ProviderContextManager();
    void processManager.load();
  }
  return processManager;
}

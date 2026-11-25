import { warn } from '../utils/logger';
import { persistedValue } from '../utils/persistedValue';
import { isRecord } from '../utils/isRecord';
import type { Consent } from './consent';

/**
 * The iOS and Android SDKs' key, but not their storage: the native store
 * prefixes it on iOS and keeps its own preferences file on Android, so an app
 * embedding both an RN and a native SDK holds two separate consent records.
 * Outside identity and session, so `reset()` never touches it: consent is a
 * compliance record scoped to the device and person, not to the analytics
 * identity. A logout must not resurrect tracking the user opted out of.
 */
export const CONSENT_KEY = 'metarouter:consent:state';

const store = persistedValue(CONSENT_KEY);

/**
 * What is persisted: the host's snapshot exactly as it arrived (after
 * stamping), plus the newest host-supplied timestamp since the last clear.
 *
 * The RAW snapshot, never the reconciled view: reconciliation is a projection
 * onto whatever registry is current, and persisting it would lose the user's
 * decision for a category one build stopped registering and a later build
 * registers again.
 *
 * `lastHostTimestamp` is the stale-snapshot watermark. Only host timestamps are
 * comparable (same clock, same unit), so an untimestamped set carries it
 * forward rather than resetting it — otherwise a host re-pushing the same
 * decision without a timestamp would let an older CMP replay overwrite a newer
 * explicit choice.
 */
export interface StoredConsent {
  consent: Consent;
  lastHostTimestamp?: number;
}

// Null for anything that is not the shape this SDK writes. Unknown fields are
// tolerated, so a downgrade past a build that added one still reads.
function parse(raw: string): StoredConsent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.consent)) return null;
  const { explicit, optOut, timestamp } = value.consent;
  if (typeof explicit !== 'boolean' || !isRecord(optOut)) return null;
  if (Object.values(optOut).some((v) => typeof v !== 'boolean')) return null;
  const watermark = value.lastHostTimestamp;
  return {
    consent: {
      explicit,
      optOut: optOut as Record<string, boolean>,
      ...(typeof timestamp === 'number' && { timestamp }),
    },
    ...(typeof watermark === 'number' && { lastHostTimestamp: watermark }),
  };
}

// Corrupt state reads as never-set — the implicit default — as on native:
// wrong-but-safe beats unusable, and the next setConsent heals it.
function parsed(raw: string | null): StoredConsent | null {
  if (raw == null) return null;
  const stored = parse(raw);
  if (!stored) warn('Stored consent state unreadable — treating as never set.');
  return stored;
}

/**
 * The stored state synchronously, from native storage; undefined without the
 * native module, when only `loadConsent()` has it. Throws when the native read
 * fails.
 */
export function loadConsentSync(): StoredConsent | null | undefined {
  const raw = store.readSync();
  return raw === undefined ? undefined : parsed(raw);
}

/**
 * Reads the stored state from AsyncStorage — the store without the native
 * module — retrying with a short backoff. A read that keeps failing THROWS: the stored state may be intact, and reading
 * it as never-set would let the next save replace the user's decision.
 */
export async function loadConsent(
  delay?: (ms: number) => Promise<void>
): Promise<StoredConsent | null> {
  return parsed(await store.read(delay));
}

/** Writes the state; null removes it. */
export async function saveConsent(stored: StoredConsent | null): Promise<void> {
  await store.write(stored === null ? null : JSON.stringify(stored));
}

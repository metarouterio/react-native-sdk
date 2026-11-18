import AsyncStorage from '@react-native-async-storage/async-storage';
import { warn } from '../utils/logger';
import { defaultDelay, getItemWithRetry } from '../utils/readWithRetry';

/** A JSON value as stamped on the wire. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ProviderContextMap = Record<string, Record<string, JsonValue>>;

/**
 * The provider → key → value map the host has set, persisted across launches
 * as one JSON value.
 *
 * Persistence is the point, not a convenience: these values come from vendor
 * SDKs that resolve asynchronously (Firebase's `getAppInstanceId()` is a
 * promise), while init emits the cold-launch events. A memory-only store would
 * miss those events on every launch — exactly the ones a vendor rejects when
 * the id is absent.
 *
 * Its own key, outside identity, session and consent, so `reset()` never
 * touches it: these are install-scoped vendor ids, not user state. A logout
 * that stopped the stamp would make every later event unforwardable.
 * Same key as the iOS and Android SDKs.
 */
export const PROVIDER_CONTEXT_KEY = 'metarouter:providers:context';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Null for a value that is not a provider → key → value object. Values were
// validated when set, and JSON.parse can only produce JSON.
function parse(raw: string): ProviderContextMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.some(([, keys]) => !isPlainObject(keys))) return null;
  // fromEntries, not assignment: a provider named "__proto__" (JSON.parse
  // makes it an own key) would otherwise replace the map's prototype.
  return Object.fromEntries(
    entries.filter(([, keys]) => Object.keys(keys as object).length > 0)
  ) as ProviderContextMap;
}

/**
 * Reads the stored map, retrying with a short backoff. Corrupt state reads as
 * never-set: rereading it would fail the same way, and the host's next set
 * heals it. A read that keeps failing THROWS instead: the map on disk may be
 * fine, and reading it as empty would let the next write replace every vendor
 * id stored in earlier launches.
 */
export async function loadProviderContext(
  delay: (ms: number) => Promise<void> = defaultDelay
): Promise<ProviderContextMap | null> {
  const read = await getItemWithRetry(PROVIDER_CONTEXT_KEY, delay);
  if (!read.ok) throw read.error;
  if (read.raw == null) return null;
  const map = parse(read.raw);
  if (!map) warn('Stored provider context unreadable — treating as unset.');
  return map;
}

/** Writes the whole map, or removes the key when it is empty. */
export async function saveProviderContext(
  map: ProviderContextMap
): Promise<void> {
  if (Object.keys(map).length === 0) {
    await AsyncStorage.removeItem(PROVIDER_CONTEXT_KEY);
  } else {
    await AsyncStorage.setItem(PROVIDER_CONTEXT_KEY, JSON.stringify(map));
  }
}

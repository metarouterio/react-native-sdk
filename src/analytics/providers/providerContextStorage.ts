import { warn } from '../utils/logger';
import { persistedValue } from '../utils/persistedValue';
import { isRecord } from '../utils/isRecord';

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
 * Same key name as the iOS and Android SDKs; stored apart from theirs (a
 * prefixed UserDefaults key on iOS, its own preferences file on Android — see
 * MetaRouterKeyValueStore), so a hybrid app's two SDKs never share it.
 */
export const PROVIDER_CONTEXT_KEY = 'metarouter:providers:context';

const store = persistedValue(PROVIDER_CONTEXT_KEY);

// Null for a value that is not a provider → key → value object. Values were
// validated when set, and JSON.parse can only produce JSON.
function parse(raw: string): ProviderContextMap | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, keys]) => !isRecord(keys))) return null;
  // fromEntries, not assignment: a provider named "__proto__" (JSON.parse
  // makes it an own key) would otherwise replace the map's prototype.
  return Object.fromEntries(
    entries.filter(([, keys]) => Object.keys(keys as object).length > 0)
  ) as ProviderContextMap;
}

// Corrupt state reads as never-set: rereading it would fail the same way, and
// the host's next set heals it.
function parsed(raw: string | null): ProviderContextMap | null {
  if (raw == null) return null;
  const map = parse(raw);
  if (!map) warn('Stored provider context unreadable — treating as unset.');
  return map;
}

/**
 * The stored map synchronously, from native storage; undefined without the
 * native module, when only `loadProviderContext()` has it. Throws when the
 * native read fails.
 */
export function loadProviderContextSync():
  | ProviderContextMap
  | null
  | undefined {
  const raw = store.readSync();
  return raw === undefined ? undefined : parsed(raw);
}

/**
 * Reads the stored map from AsyncStorage — the store without the native module
 * — retrying with a short backoff. A read that keeps failing THROWS: the map on
 * disk may be fine, and reading it as empty would let the next write replace
 * every vendor id stored in earlier launches.
 */
export async function loadProviderContext(
  delay?: (ms: number) => Promise<void>
): Promise<ProviderContextMap | null> {
  return parsed(await store.read(delay));
}

/** Writes the whole map, or removes it when it is empty. */
export async function saveProviderContext(
  map: ProviderContextMap
): Promise<void> {
  await store.write(Object.keys(map).length === 0 ? null : JSON.stringify(map));
}

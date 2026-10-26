import AsyncStorage from '@react-native-async-storage/async-storage';
import { warn } from './logger';

// Key strings are byte-identical to the iOS and Android SDKs so
// cross-platform debugging reads one vocabulary.
export const SESSION_ID_KEY = 'metarouter:session:id';
export const SESSION_COUNT_KEY = 'metarouter:session:count';
export const SESSION_LAST_ACTIVITY_KEY = 'metarouter:session:last_activity_ms';

/**
 * Persisted session state. Lives in its own keys, outside identityStorage, so
 * neither IdentityManager.reset() nor the client's reset() can end a session as
 * a side effect: a logout mid-session must not fragment the analytics session —
 * session-scoped reporting downstream (e.g. GA4) counts the visit, not the
 * login state.
 *
 * `lastActivityMs` is wall-clock epoch ms on purpose: a monotonic reading is
 * meaningless across process restarts, the only reason it is persisted at all.
 */
export interface StoredSession {
  id: string | null;
  count: number | null;
  lastActivityMs: number | null;
}

// A missing or corrupt value reads as absent, so a fresh install starts its
// counter at 1 instead of resuming a phantom count. `Number('')` is 0, hence
// the explicit minimum rather than an integer check alone.
function parseInteger(
  raw: string | null | undefined,
  min: number
): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

// Waits before each retry of a failed read. A failure here is usually transient
// (storage busy at cold start); an immediate retry tends to fail the same way.
const RETRY_DELAYS_MS = [100, 400];

async function read(): Promise<StoredSession> {
  const pairs = await AsyncStorage.multiGet([
    SESSION_ID_KEY,
    SESSION_COUNT_KEY,
    SESSION_LAST_ACTIVITY_KEY,
  ]);
  const values = new Map(pairs);
  return {
    id: values.get(SESSION_ID_KEY) ?? null,
    count: parseInteger(values.get(SESSION_COUNT_KEY), 1),
    lastActivityMs: parseInteger(values.get(SESSION_LAST_ACTIVITY_KEY), 0),
  };
}

const EMPTY: StoredSession = { id: null, count: null, lastActivityMs: null };

/**
 * Reads the stored session, retrying with a short backoff. If storage stays
 * unreadable it reads as empty — what the native SDKs see after their
 * preferences are cleared: the next event mints a session counted from 1 and
 * persists it. That loses the lifetime count, once, with a warning; the
 * alternative of not writing at all lets a later launch resume a session from
 * before the failure and interleave two session ids downstream.
 */
export async function loadSession(
  delay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<StoredSession> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      return await read();
    } catch (err) {
      lastError = err;
    }
  }
  warn(
    'Session storage unreadable — starting a new session counted from 1.',
    lastError
  );
  return EMPTY;
}

// Fire-and-forget: called from synchronous enrichment. A lost write costs at
// most one extra session after the next restart.
export function saveSession(
  id: string,
  count: number,
  lastActivityMs: number
): void {
  // One multiSet so a kill mid-write cannot leave a new id beside the
  // previous session's count or last activity.
  AsyncStorage.multiSet([
    [SESSION_ID_KEY, id],
    [SESSION_COUNT_KEY, String(count)],
    [SESSION_LAST_ACTIVITY_KEY, String(lastActivityMs)],
  ]).catch(() => {});
}

export function saveLastActivity(lastActivityMs: number): void {
  AsyncStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(lastActivityMs)).catch(
    () => {}
  );
}

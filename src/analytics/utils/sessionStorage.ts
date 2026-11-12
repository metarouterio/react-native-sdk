import AsyncStorage from '@react-native-async-storage/async-storage';
import { warn } from './logger';

// One JSON value under one key, read and written with getItem/setItem, which
// AsyncStorage 2.x and 3.x both have (2.x's multiGet/multiSet became
// getMany/setMany in 3.x, so no batch call works on both). One setItem also
// keeps the id, count and last activity consistent if the app is killed
// mid-write. The iOS and Android SDKs keep the same three fields under
// separate keys.
export const SESSION_KEY = 'metarouter:session';

/**
 * Persisted session state. Lives in its own key, outside identityStorage, so
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

// A missing or corrupt field reads as absent, so a fresh install starts its
// counter at 1 instead of resuming a phantom count.
function integerAtLeast(value: unknown, min: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min
    ? value
    : null;
}

// Waits before each retry of a failed read. A failure here is usually transient
// (storage busy at cold start); an immediate retry tends to fail the same way.
const RETRY_DELAYS_MS = [100, 400];

const EMPTY: StoredSession = { id: null, count: null, lastActivityMs: null };

// Null for a value that is not a JSON object: rereading the same bad value
// would fail the same way, so it is not retried like a failed read.
function parse(raw: string): StoredSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { id, count, lastActivityMs } = parsed as Record<string, unknown>;
  return {
    id: typeof id === 'string' && id !== '' ? id : null,
    count: integerAtLeast(count, 1),
    lastActivityMs: integerAtLeast(lastActivityMs, 0),
  };
}

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
    let raw: string | null;
    try {
      raw = await AsyncStorage.getItem(SESSION_KEY);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (raw == null) return EMPTY;
    const session = parse(raw);
    if (session) return session;
    warn(
      'Stored session is corrupt — starting a new session counted from 1.',
      raw.slice(0, 100)
    );
    return EMPTY;
  }
  warn(
    'Session storage unreadable — starting a new session counted from 1.',
    lastError
  );
  return EMPTY;
}

// Fire-and-forget: called from synchronous enrichment, so it must not throw
// into the host's track() — not even synchronously, which a storage module
// that is missing or mismatched does before a promise exists. A lost write
// costs at most one extra session after the next restart.
export function saveSession(
  id: string,
  count: number,
  lastActivityMs: number
): void {
  try {
    AsyncStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id, count, lastActivityMs })
    ).catch(() => {});
  } catch {
    // Same outcome as a rejected write.
  }
}

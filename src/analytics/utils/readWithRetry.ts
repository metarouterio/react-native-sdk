import AsyncStorage from '@react-native-async-storage/async-storage';

// Waits before each retry of a failed read. A failure here is usually transient
// (storage busy at cold start); an immediate retry tends to fail the same way.
const RETRY_DELAYS_MS = [100, 400];

export type RetriedRead =
  | { ok: true; raw: string | null }
  | { ok: false; error: unknown };

export const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads one AsyncStorage key, retrying failed reads with a short backoff.
 * `ok: false` only when every attempt threw — distinct from a key that is
 * simply absent (`raw: null`), which callers may need to treat differently.
 */
export async function getItemWithRetry(
  key: string,
  delay: (ms: number) => Promise<void> = defaultDelay
): Promise<RetriedRead> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      return { ok: true, raw: await AsyncStorage.getItem(key) };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError };
}

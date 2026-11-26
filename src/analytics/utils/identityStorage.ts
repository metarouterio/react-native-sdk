import AsyncStorage from '@react-native-async-storage/async-storage';
import { warn } from './logger';
import {
  defaultDelay,
  getItemWithRetry,
  type RetriedRead,
} from './readWithRetry';

export const ANONYMOUS_ID_KEY = 'metarouter:anonymous_id';
export const USER_ID_KEY = 'metarouter:user_id';
export const GROUP_ID_KEY = 'metarouter:group_id';
export const ADVERTISING_ID_KEY = 'metarouter:advertising_id';
// Set when the host writes an anonymousId on a device that had none, so
// install detection still reports Application Installed (the native SDKs keep
// the same marker). Cleared by the first init after it.
export const HOST_SET_MARKER_KEY = 'metarouter:anonymous_id_host_set';

const IDENTITY_KEYS = [
  ANONYMOUS_ID_KEY,
  USER_ID_KEY,
  GROUP_ID_KEY,
  ADVERTISING_ID_KEY,
  HOST_SET_MARKER_KEY,
];

/*
 * Every identity read and write runs on one chain, in call order. AsyncStorage
 * orders calls on iOS and on Android's default storage, but not on Android's
 * opt-in "next" storage, where each call is its own coroutine; a reset's clear
 * followed by a setAnonymousId must land in that order on every backend.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op);
  chain = run.catch(() => {});
  return run;
}

/*
 * Bumped by every reset(). A client records the epoch it was built in, and its
 * writes are dropped once a reset has been called since: a client being torn
 * down (an identify() reaching it right after reset(), a superseded init
 * generating an id) must not write identity into the next session.
 */
let epoch = 0;

export const currentIdentityEpoch = (): number => epoch;

async function setItem(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch (err) {
    warn(`Failed to store ${key}`, err);
  }
}

async function removeItem(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (err) {
    warn(`Failed to remove ${key}`, err);
  }
}

/** One read, null when absent or unreadable. */
export function getIdentityField(key: string): Promise<string | null> {
  return enqueue(async () => {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  });
}

/**
 * Reads an identity field, retrying failed reads. `ok: false` only when every
 * attempt threw, so a caller can tell unreadable storage from an absent key
 * (getIdentityField reports both as null).
 */
export function readIdentityField(
  key: string,
  delay: (ms: number) => Promise<void> = defaultDelay
): Promise<RetriedRead> {
  return enqueue(() => getItemWithRetry(key, delay));
}

/**
 * Reads several identity fields as one step on the chain, in parallel, each
 * retried as readIdentityField does.
 */
export function readIdentityFields(
  keys: readonly string[],
  delay: (ms: number) => Promise<void> = defaultDelay
): Promise<RetriedRead[]> {
  return enqueue(() =>
    Promise.all(keys.map((key) => getItemWithRetry(key, delay)))
  );
}

/**
 * Writes an identity field. With `writerEpoch`, the write is dropped when a
 * reset() has been called since that writer was built.
 */
export function setIdentityField(
  key: string,
  value: string,
  writerEpoch?: number
): Promise<void> {
  return enqueue(async () => {
    if (writerEpoch !== undefined && writerEpoch !== epoch) return;
    await setItem(key, value);
  });
}

/** Removes an identity field; `writerEpoch` as for setIdentityField. */
export function removeIdentityField(
  key: string,
  writerEpoch?: number
): Promise<void> {
  return enqueue(async () => {
    if (writerEpoch !== undefined && writerEpoch !== epoch) return;
    await removeItem(key);
  });
}

/**
 * Stores an anonymousId the host set, at call time. On a device with no id
 * stored yet it also sets the install marker, so the id doesn't count as prior
 * identity. Unreadable storage writes the id without the marker: install
 * detection then reports an existing user, its rule for unreadable storage.
 */
export function writeHostAnonymousId(id: string): Promise<void> {
  return enqueue(async () => {
    const stored = await getItemWithRetry(ANONYMOUS_ID_KEY);
    if (stored.ok && stored.raw === id) return;
    if (stored.ok && !stored.raw) await setItem(HOST_SET_MARKER_KEY, '1');
    await setItem(ANONYMOUS_ID_KEY, id);
  });
}

/**
 * reset(): starts a new epoch and clears every identity key, in call order with
 * the writes around it, whether or not a client is running.
 */
export function clearIdentityStorage(): Promise<void> {
  epoch++;
  return enqueue(async () => {
    for (const key of IDENTITY_KEYS) await removeItem(key);
  });
}

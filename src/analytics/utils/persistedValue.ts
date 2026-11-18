import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { warn } from './logger';
import { defaultDelay, getItemWithRetry } from './readWithRetry';

interface NativeKeyValueStore {
  getSync(key: string): unknown;
  /** Null removes the key. */
  setSync(key: string, value: string | null): unknown;
}

// Resolved once per process.
let resolved: NativeKeyValueStore | null | undefined;

function nativeStore(): NativeKeyValueStore | null {
  if (resolved === undefined) {
    const mod = NativeModules.MetaRouterKeyValueStore as
      | NativeKeyValueStore
      | undefined;
    resolved = mod ?? null;
  }
  return resolved;
}

/** Test seam: forget the resolved module so the next call resolves again. */
export function resetNativeStoreForTests(): void {
  resolved = undefined;
}

/**
 * One persisted string value, read synchronously when it can be. State that
 * must be known before host code runs lives in the MetaRouterKeyValueStore
 * native module (UserDefaults, SharedPreferences), read synchronously at SDK
 * load as the iOS and Android SDKs read theirs.
 *
 * Without the native module (Expo Go, JS shipped over the air onto an older
 * binary) the value lives in AsyncStorage instead and arrives after host code
 * has started. The two are never merged: a value written there is not carried
 * over when the binary gains the module, nor removed — it is never read again.
 * Nothing persisted this way shipped before the module did, and the hosts that
 * set these values set them again on every launch.
 */
export interface PersistedValue {
  /**
   * The stored value synchronously, null when nothing is stored; undefined
   * without the native module, when only `read()` has it. Throws when the
   * native read fails or returns something other than a string or null: the
   * value may be intact, and reading it as absent would let the next save
   * replace it.
   */
  readSync(): string | null | undefined;
  /**
   * The stored value from AsyncStorage, retried with backoff — the store
   * without the native module. Throws when every attempt failed.
   */
  read(delay?: (ms: number) => Promise<void>): Promise<string | null>;
  /** Writes the value; null removes it. */
  write(raw: string | null): Promise<void>;
}

export function persistedValue(key: string): PersistedValue {
  return {
    readSync() {
      const store = nativeStore();
      if (!store) return undefined;
      const raw: unknown = store.getSync(key);
      if (raw === null || typeof raw === 'string') return raw;
      throw new Error(`MetaRouterKeyValueStore.getSync returned ${typeof raw}`);
    },

    async read(delay = defaultDelay) {
      // On the fallback path only: once per key, during the load at SDK import.
      warn(
        `MetaRouterKeyValueStore native module is not available (Expo Go, or JS newer than the app binary): ${key} loads asynchronously from AsyncStorage.`
      );
      const read = await getItemWithRetry(key, delay);
      if (!read.ok) throw read.error;
      return read.raw;
    },

    async write(raw) {
      const store = nativeStore();
      if (store) {
        // Only a literal true counts: anything else, a Promise from an
        // environment that runs blocking methods asynchronously included, is
        // not known to have landed.
        if (store.setSync(key, raw) !== true) {
          throw new Error(`MetaRouterKeyValueStore could not write ${key}`);
        }
      } else if (raw === null) {
        await AsyncStorage.removeItem(key);
      } else {
        await AsyncStorage.setItem(key, raw);
      }
    },
  };
}

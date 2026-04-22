import { NativeModules } from 'react-native';
import { warn } from '../utils/logger';

/**
 * Native bridge for the single queue disk file (queue.v1.json).
 *
 * Native module contract (iOS + Android):
 * - readSnapshot(): Promise<string | null>   — full contents, or null if no file
 * - writeSnapshot(data: string): Promise<void> — atomic overwrite
 * - deleteSnapshot(): Promise<void>            — delete if present
 * - exists(): Promise<boolean>                 — cheap existence check
 *
 * Append / merge / cap logic lives in JS (PersistentEventQueue) rather than
 * native so the policy stays in one place and is easy to test.
 */
interface NativeQueueStorageModule {
  exists(): Promise<boolean>;
  readSnapshot(): Promise<string | null>;
  writeSnapshot(data: string): Promise<void>;
  deleteSnapshot(): Promise<void>;
}

function getModule(): NativeQueueStorageModule | null {
  const mod = NativeModules.MetaRouterQueueStorage as
    | NativeQueueStorageModule
    | undefined;
  if (!mod) {
    warn(
      'MetaRouterQueueStorage native module is not available. Queue persistence is disabled.'
    );
    return null;
  }
  return mod;
}

export async function exists(): Promise<boolean> {
  const mod = getModule();
  if (!mod?.exists) return false;
  try {
    return await mod.exists();
  } catch (err) {
    warn('Failed to check queue snapshot existence:', err);
    return false;
  }
}

export async function readSnapshot(): Promise<string | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    return await mod.readSnapshot();
  } catch (err) {
    warn('Failed to read queue snapshot from disk:', err);
    throw err;
  }
}

export async function writeSnapshot(data: string): Promise<void> {
  const mod = getModule();
  if (!mod) {
    throw new Error(
      'MetaRouterQueueStorage native module is not available; cannot write queue snapshot.'
    );
  }
  try {
    await mod.writeSnapshot(data);
  } catch (err) {
    warn('Failed to write queue snapshot to disk:', err);
    throw err;
  }
}

export async function deleteSnapshot(): Promise<void> {
  const mod = getModule();
  if (!mod) return;
  try {
    await mod.deleteSnapshot();
  } catch (err) {
    warn('Failed to delete queue snapshot from disk:', err);
    throw err;
  }
}

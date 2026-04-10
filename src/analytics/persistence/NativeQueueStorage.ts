import { NativeModules } from 'react-native';
import { warn } from '../utils/logger';

/**
 * Native bridge for queue snapshot persistence.
 *
 * Expected native module contract:
 * - readSnapshot(): Promise<string | null>   — returns file contents or null
 * - writeSnapshot(data: string): Promise<void> — overwrites file with data
 * - deleteSnapshot(): Promise<void>            — deletes file if it exists
 *
 * Overflow snapshot methods (for offline disk overflow):
 * - readOverflowSnapshot(): Promise<string | null>
 * - writeOverflowSnapshot(data: string): Promise<void>
 * - deleteOverflowSnapshot(): Promise<void>
 */
interface NativeQueueStorageModule {
  readSnapshot(): Promise<string | null>;
  writeSnapshot(data: string): Promise<void>;
  deleteSnapshot(): Promise<void>;
  readOverflowSnapshot?(): Promise<string | null>;
  writeOverflowSnapshot?(data: string): Promise<void>;
  deleteOverflowSnapshot?(): Promise<void>;
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

export async function readSnapshot(): Promise<string | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    return await mod.readSnapshot();
  } catch (err) {
    warn('Failed to read queue snapshot from disk:', err);
    return null;
  }
}

export async function writeSnapshot(data: string): Promise<void> {
  const mod = getModule();
  if (!mod) return;
  try {
    await mod.writeSnapshot(data);
  } catch (err) {
    warn('Failed to write queue snapshot to disk:', err);
  }
}

export async function deleteSnapshot(): Promise<void> {
  const mod = getModule();
  if (!mod) return;
  try {
    await mod.deleteSnapshot();
  } catch (err) {
    warn('Failed to delete queue snapshot from disk:', err);
  }
}

// --- Overflow snapshot (offline disk overflow) ---

export async function readOverflowSnapshot(): Promise<string | null> {
  const mod = getModule();
  if (!mod?.readOverflowSnapshot) return null;
  try {
    return await mod.readOverflowSnapshot();
  } catch (err) {
    warn('Failed to read overflow snapshot from disk:', err);
    return null;
  }
}

export async function writeOverflowSnapshot(data: string): Promise<void> {
  const mod = getModule();
  if (!mod?.writeOverflowSnapshot) return;
  try {
    await mod.writeOverflowSnapshot(data);
  } catch (err) {
    warn('Failed to write overflow snapshot to disk:', err);
  }
}

export async function deleteOverflowSnapshot(): Promise<void> {
  const mod = getModule();
  if (!mod?.deleteOverflowSnapshot) return;
  try {
    await mod.deleteOverflowSnapshot();
  } catch (err) {
    warn('Failed to delete overflow snapshot from disk:', err);
  }
}

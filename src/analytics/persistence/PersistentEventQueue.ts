import type Dispatcher from '../dispatcher';
import {
  readSnapshot,
  writeSnapshot,
  deleteSnapshot as nativeDeleteSnapshot,
} from './NativeQueueStorage';
import {
  SNAPSHOT_VERSION,
  FLUSH_THRESHOLD_EVENTS,
  FLUSH_THRESHOLD_BYTES,
  type QueueSnapshot,
} from './types';
import { log, warn } from '../utils/logger';

/**
 * Module-level guard: rehydrate at most once per process lifetime.
 * Prevents duplicate rehydration if init() is called multiple times
 * (e.g. after a reset + reinit in the same session).
 */
let hasRehydrated = false;

export class PersistentEventQueue {
  private readonly dispatcher: Dispatcher;
  private flushInFlight: Promise<void> | null = null;

  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }

  /**
   * Rehydrate events from disk into the in-memory queue.
   * Only runs once per process lifetime.
   */
  async rehydrate(): Promise<void> {
    if (hasRehydrated) {
      log('Rehydration already completed this process — skipping');
      return;
    }
    hasRehydrated = true;

    try {
      const raw = await readSnapshot();
      if (!raw) {
        log('No queue snapshot found on disk');
        return;
      }

      let snapshot: QueueSnapshot;
      try {
        snapshot = JSON.parse(raw);
      } catch {
        warn('Queue snapshot is corrupt JSON — discarding');
        await nativeDeleteSnapshot();
        return;
      }

      if (snapshot.version !== SNAPSHOT_VERSION) {
        warn(
          `Queue snapshot version ${snapshot.version} is not supported (expected ${SNAPSHOT_VERSION}) — discarding`
        );
        await nativeDeleteSnapshot();
        return;
      }

      if (!Array.isArray(snapshot.events) || snapshot.events.length === 0) {
        log('Queue snapshot has no events — discarding');
        await nativeDeleteSnapshot();
        return;
      }

      log(`Rehydrating ${snapshot.events.length} events from disk`);
      this.dispatcher.enqueueFront(snapshot.events);

      // Clean up disk after successful rehydration
      await nativeDeleteSnapshot();
      log('Queue snapshot deleted after rehydration');
    } catch (err) {
      warn('Failed to rehydrate queue from disk:', err);
    }
  }

  /**
   * Flush current in-memory queue state to disk.
   * Serialized: concurrent calls coalesce into one write.
   */
  async flushToDisk(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;

    this.flushInFlight = this._doFlushToDisk().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async _doFlushToDisk(): Promise<void> {
    const queue = this.dispatcher.getQueueRef();

    if (queue.length === 0) {
      log('Queue empty — deleting snapshot');
      await nativeDeleteSnapshot();
      return;
    }

    const snapshot: QueueSnapshot = {
      version: SNAPSHOT_VERSION,
      events: [...queue], // shallow copy to avoid mutation during async write
    };

    const data = JSON.stringify(snapshot);
    log(`Flushing ${queue.length} events to disk (${data.length} chars)`);
    await writeSnapshot(data);
  }

  /**
   * Check if the queue has crossed a flush-to-disk threshold.
   */
  shouldFlushToDisk(): boolean {
    const queue = this.dispatcher.getQueueRef();
    if (queue.length >= FLUSH_THRESHOLD_EVENTS) return true;
    if (this.dispatcher.getQueueSizeBytes() >= FLUSH_THRESHOLD_BYTES)
      return true;
    return false;
  }

  /**
   * Delete the disk snapshot (used during reset).
   */
  async deleteSnapshot(): Promise<void> {
    await nativeDeleteSnapshot();
  }
}

/**
 * Reset the rehydration guard. Exposed ONLY for testing.
 * @internal
 */
export function _resetRehydrationGuard(): void {
  hasRehydrated = false;
}

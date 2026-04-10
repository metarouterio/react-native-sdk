import type { EventPayload } from '../types';
import type Dispatcher from '../dispatcher';
import {
  readSnapshot,
  writeSnapshot,
  deleteSnapshot as nativeDeleteSnapshot,
  readOverflowSnapshot,
  writeOverflowSnapshot,
  deleteOverflowSnapshot as nativeDeleteOverflowSnapshot,
} from './NativeQueueStorage';
import {
  SNAPSHOT_VERSION,
  FLUSH_THRESHOLD_BYTES,
  FLUSH_THRESHOLD_COUNT,
  DEFAULT_EVENT_TTL_MS,
  DEFAULT_MAX_OFFLINE_DISK_EVENTS,
  OVERFLOW_BATCH_THRESHOLD,
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
  private _rehydratedEvents: number = 0;
  private readonly maxOfflineDiskEvents: number;
  private overflowBuffer: EventPayload[] = [];
  private overflowFlushInFlight: Promise<void> | null = null;
  private drainInFlight: Promise<void> | null = null;

  constructor(
    dispatcher: Dispatcher,
    opts?: { maxOfflineDiskEvents?: number }
  ) {
    this.dispatcher = dispatcher;
    this.maxOfflineDiskEvents =
      opts?.maxOfflineDiskEvents ?? DEFAULT_MAX_OFFLINE_DISK_EVENTS;
  }

  get rehydratedEvents(): number {
    return this._rehydratedEvents;
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

      // Filter out events older than TTL
      const now = Date.now();
      const cutoff = now - DEFAULT_EVENT_TTL_MS;
      const fresh = snapshot.events.filter((e) => {
        const ts = (e as any).timestamp;
        if (!ts) return true; // keep events without timestamp
        const eventTime = new Date(ts).getTime();
        return !isNaN(eventTime) && eventTime > cutoff;
      });

      const expired = snapshot.events.length - fresh.length;
      if (expired > 0) {
        warn(`Dropped ${expired} expired events (older than 7 days)`);
      }

      if (fresh.length === 0) {
        log('All snapshot events expired — discarding');
        await nativeDeleteSnapshot();
        return;
      }

      this.dispatcher.enqueueFront(fresh);
      this._rehydratedEvents = fresh.length;
      log(`Rehydrated ${fresh.length} events from disk`);

      // Clean up disk after successful rehydration
      await nativeDeleteSnapshot();
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
    try {
      const queue = this.dispatcher.getQueueRef();

      if (queue.length === 0) {
        log('Queue empty — deleting snapshot');
        await nativeDeleteSnapshot();
      } else {
        const snapshot: QueueSnapshot = {
          version: SNAPSHOT_VERSION,
          events: [...queue], // shallow copy to avoid mutation during async write
        };

        const data = JSON.stringify(snapshot);
        await writeSnapshot(data);
        log(`Queue snapshot written to disk (${queue.length} events)`);
      }

      // Also flush overflow buffer to disk on background
      if (this.overflowBuffer.length > 0) {
        await this.flushOverflowBufferToDisk();
      }
    } catch (err) {
      warn('Failed to flush queue to disk:', err);
    }
  }

  /**
   * Check if the queue has crossed a flush-to-disk threshold.
   */
  shouldFlushToDisk(): boolean {
    return (
      this.dispatcher.getQueueRef().length >= FLUSH_THRESHOLD_COUNT ||
      this.dispatcher.getQueueSizeBytes() >= FLUSH_THRESHOLD_BYTES
    );
  }

  /**
   * Handle events evicted from the memory queue (overflow callback).
   * Buffers events and flushes to disk in batches.
   */
  handleOverflow(events: EventPayload[]): void {
    this.overflowBuffer.push(...events);

    // Enforce disk cap on buffer: drop oldest if overflow exceeds max
    while (this.overflowBuffer.length > this.maxOfflineDiskEvents) {
      this.overflowBuffer.shift();
      warn('Offline disk cap reached — dropped oldest overflow event');
    }

    if (this.overflowBuffer.length >= OVERFLOW_BATCH_THRESHOLD) {
      void this.flushOverflowBufferToDisk();
    }
  }

  /**
   * Flush the in-memory overflow buffer to the overflow disk store.
   * Singleflight: concurrent calls coalesce into one write.
   */
  async flushOverflowBufferToDisk(): Promise<void> {
    if (this.overflowFlushInFlight) return this.overflowFlushInFlight;

    this.overflowFlushInFlight = this._doFlushOverflowToDisk().finally(() => {
      this.overflowFlushInFlight = null;
    });
    return this.overflowFlushInFlight;
  }

  private async _doFlushOverflowToDisk(): Promise<void> {
    if (this.overflowBuffer.length === 0) return;

    try {
      const batch = this.overflowBuffer.splice(0);

      // Read existing overflow on disk
      const raw = await readOverflowSnapshot();
      let existing: EventPayload[] = [];
      if (raw) {
        try {
          const snapshot: QueueSnapshot = JSON.parse(raw);
          if (
            snapshot.version === SNAPSHOT_VERSION &&
            Array.isArray(snapshot.events)
          ) {
            existing = snapshot.events;
          }
        } catch {
          warn('Overflow snapshot is corrupt JSON — overwriting');
        }
      }

      let combined = existing.concat(batch);

      // Enforce disk cap
      if (combined.length > this.maxOfflineDiskEvents) {
        const dropCount = combined.length - this.maxOfflineDiskEvents;
        combined = combined.slice(dropCount);
        warn(
          `Offline overflow disk cap enforced — dropped ${dropCount} oldest events`
        );
      }

      const snapshot: QueueSnapshot = {
        version: SNAPSHOT_VERSION,
        events: combined,
      };
      await writeOverflowSnapshot(JSON.stringify(snapshot));
      log(
        `Overflow buffer flushed to disk (${batch.length} new, ${combined.length} total on disk)`
      );
    } catch (err) {
      warn('Failed to flush overflow buffer to disk:', err);
    }
  }

  /**
   * Drain overflow events directly from disk to network in batches.
   * Does NOT load events into the memory queue.
   * Called on offline→online transition.
   */
  async drainDiskToNetwork(dispatcher: Dispatcher): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;

    this.drainInFlight = this._doDrainDiskToNetwork(dispatcher).finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  private async _doDrainDiskToNetwork(dispatcher: Dispatcher): Promise<void> {
    try {
      // First, flush any remaining buffer to disk
      await this.flushOverflowBufferToDisk();

      while (true) {
        const raw = await readOverflowSnapshot();
        if (!raw) return;

        let snapshot: QueueSnapshot;
        try {
          snapshot = JSON.parse(raw);
        } catch {
          warn('Overflow snapshot is corrupt during drain — deleting');
          await nativeDeleteOverflowSnapshot();
          return;
        }

        if (!Array.isArray(snapshot.events) || snapshot.events.length === 0) {
          await nativeDeleteOverflowSnapshot();
          return;
        }

        // Filter expired events
        const now = Date.now();
        const cutoff = now - DEFAULT_EVENT_TTL_MS;
        const events = snapshot.events.filter((e) => {
          const ts = (e as any).timestamp;
          if (!ts) return true;
          const eventTime = new Date(ts).getTime();
          return !isNaN(eventTime) && eventTime > cutoff;
        });

        if (events.length === 0) {
          log('All overflow events expired — deleting');
          await nativeDeleteOverflowSnapshot();
          return;
        }

        // Take a batch from the front (oldest first)
        const batchSize = Math.min(100, events.length);
        const batch = events.slice(0, batchSize);
        const remaining = events.slice(batchSize);

        const success = await dispatcher.sendBatchDirect(batch);
        if (success) {
          if (remaining.length === 0) {
            await nativeDeleteOverflowSnapshot();
            log('Overflow disk drain complete');
          } else {
            const updated: QueueSnapshot = {
              version: SNAPSHOT_VERSION,
              events: remaining,
            };
            await writeOverflowSnapshot(JSON.stringify(updated));
            log(
              `Overflow drain batch sent (${batch.length}), ${remaining.length} remaining on disk`
            );
          }
        } else {
          // Network failed — stop draining, will retry on next online transition
          log(
            `Overflow drain paused — network send failed, ${events.length} events remain on disk`
          );
          return;
        }
      }
    } catch (err) {
      warn('Failed to drain overflow from disk:', err);
    }
  }

  /**
   * Get the number of events in the overflow buffer (not yet flushed to disk).
   */
  get overflowBufferCount(): number {
    return this.overflowBuffer.length;
  }

  /**
   * Delete the disk snapshot (used during reset).
   */
  async deleteSnapshot(): Promise<void> {
    await nativeDeleteSnapshot();
    await nativeDeleteOverflowSnapshot();
    this.overflowBuffer.length = 0;
  }
}

/**
 * Reset the rehydration guard. Exposed ONLY for testing.
 * @internal
 */
export function _resetRehydrationGuard(): void {
  hasRehydrated = false;
}

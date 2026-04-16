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
  type QueueSnapshot,
} from './types';
import {
  ResponseCategory,
  categorizeResponse,
} from '../utils/responseCategory';
import { log, warn } from '../utils/logger';

/**
 * Module-level guard: rehydrate at most once per process lifetime.
 * Prevents duplicate rehydration if init() is called multiple times
 * (e.g. after a reset + reinit in the same session).
 */
let hasRehydrated = false;

/**
 * Default batch size for draining overflow disk to network.
 * May be halved on 413 responses.
 */
const DRAIN_BATCH_SIZE = 100;

export class PersistentEventQueue {
  private readonly dispatcher: Dispatcher;
  private flushInFlight: Promise<void> | null = null;
  private _rehydratedEvents: number = 0;
  private readonly maxOfflineDiskEvents: number;
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
   * Flush events to the overflow disk store.
   * Called when the memory queue hits capacity (onCapacityOverflow) or
   * when a flush triggers while offline (onFlushToOfflineStorage).
   * The entire queue is drained and appended to the overflow disk file.
   * Singleflight: concurrent calls coalesce into one write.
   */
  flushEventsToOverflowDisk(events: EventPayload[]): void {
    if (events.length === 0) return;
    void this._flushEventsToOverflowDisk(events);
  }

  private async _flushEventsToOverflowDisk(
    events: EventPayload[]
  ): Promise<void> {
    // Singleflight: if a write is already in flight, queue up after it
    if (this.overflowFlushInFlight) {
      await this.overflowFlushInFlight;
    }

    this.overflowFlushInFlight = this._doWriteToOverflowDisk(events).finally(
      () => {
        this.overflowFlushInFlight = null;
      }
    );
    return this.overflowFlushInFlight;
  }

  private async _doWriteToOverflowDisk(events: EventPayload[]): Promise<void> {
    try {
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

      let combined = existing.concat(events);

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
        `Flushed ${events.length} events to overflow disk (${combined.length} total on disk)`
      );
    } catch (err) {
      warn('Failed to flush events to overflow disk:', err);
    }
  }

  /**
   * Drain overflow events directly from disk to network in batches.
   * Does NOT load events into the memory queue.
   * Called on offline→online transition and after successful online flushes.
   *
   * Response handling:
   * - 413: halves batch size, retries. Drops at batchSize=1
   * - 5xx/408/429: stops, retries on next online transition
   * - 401/403/404: fatal, deletes overflow store
   * - Other 4xx: drops batch, continues
   * - Batch size restores after success
   */
  async drainDiskToNetwork(dispatcher: Dispatcher): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;

    this.drainInFlight = this._doDrainDiskToNetwork(dispatcher).finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  private async _doDrainDiskToNetwork(dispatcher: Dispatcher): Promise<void> {
    let batchSize = DRAIN_BATCH_SIZE;

    try {
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
        const n = Math.min(batchSize, events.length);
        const batch = events.slice(0, n);
        const remaining = events.slice(n);

        const response = await dispatcher.sendBatchDirect(batch);

        // Network/transport error — stop, retry on next online transition
        if (!response) {
          log(
            `Overflow drain paused — network error, ${events.length} events remain on disk`
          );
          // Write back with expired events filtered
          if (events.length !== snapshot.events.length) {
            await writeOverflowSnapshot(
              JSON.stringify({ version: SNAPSHOT_VERSION, events })
            );
          }
          return;
        }

        const category = categorizeResponse(response.statusCode);

        switch (category) {
          case ResponseCategory.SUCCESS: {
            // Restore batch size after success
            if (batchSize < DRAIN_BATCH_SIZE) {
              batchSize = Math.min(batchSize * 2, DRAIN_BATCH_SIZE);
            }

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
            break;
          }

          case ResponseCategory.PAYLOAD_TOO_LARGE: {
            if (batchSize > 1) {
              batchSize = Math.max(1, Math.floor(batchSize / 2));
              warn(`Overflow drain: 413 — halving batch size to ${batchSize}`);
              // Write back filtered events before retrying with smaller batch
              if (events.length !== snapshot.events.length) {
                await writeOverflowSnapshot(
                  JSON.stringify({ version: SNAPSHOT_VERSION, events })
                );
              }
              // Continue loop with smaller batch
            } else {
              // batchSize=1, drop the offending event
              const ids = (batch as any[])
                .map((e) => (e as any).messageId)
                .join(',');
              warn(
                `Overflow drain: dropping oversize event(s) at batchSize=1; messageIds=${ids}`
              );
              if (remaining.length === 0) {
                await nativeDeleteOverflowSnapshot();
              } else {
                await writeOverflowSnapshot(
                  JSON.stringify({
                    version: SNAPSHOT_VERSION,
                    events: remaining,
                  })
                );
              }
            }
            break;
          }

          case ResponseCategory.SERVER_ERROR:
          case ResponseCategory.RATE_LIMITED: {
            warn(
              `Overflow drain paused — ${response.statusCode}, ${events.length} events remain on disk`
            );
            // Write back with expired events filtered
            if (events.length !== snapshot.events.length) {
              await writeOverflowSnapshot(
                JSON.stringify({ version: SNAPSHOT_VERSION, events })
              );
            }
            return;
          }

          case ResponseCategory.FATAL_CONFIG: {
            warn(
              `Overflow drain: fatal config error ${response.statusCode} — deleting overflow store`
            );
            await nativeDeleteOverflowSnapshot();
            return;
          }

          case ResponseCategory.CLIENT_ERROR: {
            warn(
              `Overflow drain: dropping batch due to client error ${response.statusCode}`
            );
            if (remaining.length === 0) {
              await nativeDeleteOverflowSnapshot();
            } else {
              await writeOverflowSnapshot(
                JSON.stringify({
                  version: SNAPSHOT_VERSION,
                  events: remaining,
                })
              );
            }
            // Continue draining next batch
            break;
          }
        }
      }
    } catch (err) {
      warn('Failed to drain overflow from disk:', err);
    }
  }

  /**
   * Delete the disk snapshot (used during reset).
   */
  async deleteSnapshot(): Promise<void> {
    await nativeDeleteSnapshot();
    await nativeDeleteOverflowSnapshot();
  }
}

/**
 * Reset the rehydration guard. Exposed ONLY for testing.
 * @internal
 */
export function _resetRehydrationGuard(): void {
  hasRehydrated = false;
}

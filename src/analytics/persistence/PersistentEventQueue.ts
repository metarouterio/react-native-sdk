import type { EventPayload } from '../types';
import type Dispatcher from '../dispatcher';
import {
  exists as nativeExists,
  readSnapshot,
  writeSnapshot,
  deleteSnapshot as nativeDeleteSnapshot,
} from './NativeQueueStorage';
import {
  SNAPSHOT_VERSION,
  FLUSH_THRESHOLD_BYTES,
  FLUSH_THRESHOLD_COUNT,
  DEFAULT_EVENT_TTL_MS,
  DEFAULT_MAX_DISK_EVENTS,
  type QueueSnapshot,
} from './types';
import {
  ResponseCategory,
  categorizeResponse,
} from '../utils/responseCategory';
import { log, warn } from '../utils/logger';

/**
 * Default batch size for draining disk events to network.
 * May be halved on 413 responses.
 */
const DRAIN_BATCH_SIZE = 100;

/**
 * Memory + disk coordination for the event queue.
 *
 * Single disk file (queue.v1.json) backs both crash-safety (background flush)
 * and offline overflow. All writes go through {@link flushEventsToDisk} which
 * reads existing disk contents, merges the new events, enforces the disk cap,
 * and atomically writes back.
 *
 * On boot, {@link checkForPersistedEvents} does a cheap existence check and
 * sets {@link hasDiskData}. The in-memory queue starts empty; when online,
 * the dispatcher drains disk events directly to the network via
 * {@link drainDiskToNetwork} instead of rehydrating into memory.
 */
export class PersistentEventQueue {
  private readonly dispatcher: Dispatcher;
  private readonly maxDiskEvents: number;
  private _hasDiskData: boolean = false;

  /** Serializes all disk writes (flushEventsToDisk, flushToDisk). */
  private diskWriteInFlight: Promise<void> | null = null;
  /** Guards drainDiskToNetwork (read-then-delete semantics). */
  private drainInFlight: Promise<void> | null = null;

  constructor(dispatcher: Dispatcher, opts?: { maxDiskEvents?: number }) {
    this.dispatcher = dispatcher;
    this.maxDiskEvents = opts?.maxDiskEvents ?? DEFAULT_MAX_DISK_EVENTS;
  }

  /** True when a disk snapshot existed at boot or was written since. */
  get hasDiskData(): boolean {
    return this._hasDiskData;
  }

  /**
   * Boot-time cheap existence check.
   * Sets {@link hasDiskData} without reading or parsing the snapshot file,
   * so we can decide whether to trigger a drain without paying the cost of
   * loading a potentially-large snapshot into memory.
   */
  async checkForPersistedEvents(): Promise<boolean> {
    try {
      this._hasDiskData = await nativeExists();
      if (this._hasDiskData) {
        log('Persisted events detected on disk — drain pending');
      }
      return this._hasDiskData;
    } catch (err) {
      warn('Failed to check for persisted events:', err);
      this._hasDiskData = false;
      return false;
    }
  }

  /**
   * Flush the in-memory queue to disk (append + cap).
   * Called on app background and when the flush-to-disk threshold is hit.
   * Serialized against other disk writes.
   *
   * No-op when persistence is disabled (maxDiskEvents === 0). Memory queue
   * is left intact so a subsequent foreground flush can still try to send
   * those events; on app kill they are lost (documented tradeoff).
   */
  async flushToDisk(): Promise<void> {
    if (this.maxDiskEvents === 0) return;
    const queue = this.dispatcher.getQueueRef();
    if (queue.length === 0) return;
    const events = this.dispatcher.drainQueue();
    return this.flushEventsToDisk(events);
  }

  /**
   * Append explicit events to the disk store (read-merge-cap-write).
   * Called by dispatcher onCapacityOverflow / onFlushToDisk callbacks.
   * Serialized against other disk writes.
   *
   * No-op when persistence is disabled (maxDiskEvents === 0) — events
   * passed here have already been spliced out of the memory queue by the
   * dispatcher, so in 0-mode they are lost.
   */
  async flushEventsToDisk(events: EventPayload[]): Promise<void> {
    if (events.length === 0) return;
    if (this.maxDiskEvents === 0) return;

    const prev = this.diskWriteInFlight;
    const next = (async () => {
      if (prev) await prev;
      await this._doFlushEventsToDisk(events);
    })();
    this.diskWriteInFlight = next.finally(() => {
      if (this.diskWriteInFlight === next) this.diskWriteInFlight = null;
    });
    return this.diskWriteInFlight;
  }

  private async _doFlushEventsToDisk(events: EventPayload[]): Promise<void> {
    try {
      const existing = await this._readExistingEvents();
      let combined = existing.concat(events);

      if (combined.length > this.maxDiskEvents) {
        const dropCount = combined.length - this.maxDiskEvents;
        combined = combined.slice(dropCount);
        warn(`Disk store cap reached — dropped ${dropCount} oldest events`);
      }

      if (combined.length === 0) {
        await nativeDeleteSnapshot();
        this._hasDiskData = false;
        return;
      }

      const snapshot: QueueSnapshot = {
        version: SNAPSHOT_VERSION,
        events: combined,
      };
      await writeSnapshot(JSON.stringify(snapshot));
      this._hasDiskData = true;
      log(
        `Memory queue flushed to disk: ${events.length} events, ${combined.length} total on disk`
      );
    } catch (err) {
      warn('Failed to flush events to disk:', err);
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
   * Drain disk events directly to network in batches. Does NOT load events
   * into the memory queue. Called on offline→online transition and after
   * successful online flushes.
   *
   * Response handling:
   * - 2xx: advances and deletes sent events; restores batch size after 413
   * - 413: halves batch size, retries. Drops at batchSize=1
   * - 5xx/408/429: stops, writes remainder back, retries on next online transition
   * - 401/403/404: fatal, deletes disk store
   * - Other 4xx: drops batch, continues
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
        const raw = await readSnapshot();
        if (!raw) {
          this._hasDiskData = false;
          return;
        }

        let snapshot: QueueSnapshot;
        try {
          snapshot = JSON.parse(raw);
        } catch {
          warn('Queue snapshot is corrupt during drain — deleting');
          await nativeDeleteSnapshot();
          this._hasDiskData = false;
          return;
        }

        if (!Array.isArray(snapshot.events) || snapshot.events.length === 0) {
          await nativeDeleteSnapshot();
          this._hasDiskData = false;
          return;
        }

        const events = filterExpired(snapshot.events);
        const droppedExpired = snapshot.events.length - events.length;
        if (droppedExpired > 0) {
          log(
            `Drain TTL filter dropped ${droppedExpired} event(s) older than 7 days`
          );
        }

        if (events.length === 0) {
          log('All disk events expired — deleting');
          await nativeDeleteSnapshot();
          this._hasDiskData = false;
          return;
        }

        const n = Math.min(batchSize, events.length);
        const batch = events.slice(0, n);
        const remaining = events.slice(n);

        const response = await dispatcher.sendBatchDirect(batch);

        if (!response) {
          log(
            `Disk drain paused — network error, ${events.length} event(s) remain on disk`
          );
          if (droppedExpired > 0) {
            await writeSnapshot(
              JSON.stringify({ version: SNAPSHOT_VERSION, events })
            );
          }
          return;
        }

        const category = categorizeResponse(response.statusCode);

        switch (category) {
          case ResponseCategory.SUCCESS: {
            if (batchSize < DRAIN_BATCH_SIZE) {
              batchSize = Math.min(batchSize * 2, DRAIN_BATCH_SIZE);
            }

            if (remaining.length === 0) {
              await nativeDeleteSnapshot();
              this._hasDiskData = false;
              log('Disk store drain complete');
            } else {
              await writeSnapshot(
                JSON.stringify({
                  version: SNAPSHOT_VERSION,
                  events: remaining,
                })
              );
              log(
                `Disk drain batch sent (${batch.length}), ${remaining.length} remaining on disk`
              );
            }
            break;
          }

          case ResponseCategory.PAYLOAD_TOO_LARGE: {
            if (batchSize > 1) {
              batchSize = Math.max(1, Math.floor(batchSize / 2));
              warn(`Disk drain: 413 — halving batch size to ${batchSize}`);
              if (droppedExpired > 0) {
                await writeSnapshot(
                  JSON.stringify({ version: SNAPSHOT_VERSION, events })
                );
              }
            } else {
              const ids = (batch as any[])
                .map((e) => (e as any).messageId)
                .join(',');
              warn(
                `Disk drain: dropping oversize event(s) at batchSize=1; messageIds=${ids}`
              );
              if (remaining.length === 0) {
                await nativeDeleteSnapshot();
                this._hasDiskData = false;
              } else {
                await writeSnapshot(
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
              `Disk drain paused — ${response.statusCode}, ${events.length} event(s) remain on disk`
            );
            if (droppedExpired > 0) {
              await writeSnapshot(
                JSON.stringify({ version: SNAPSHOT_VERSION, events })
              );
            }
            return;
          }

          case ResponseCategory.FATAL_CONFIG: {
            warn(
              `Disk drain: fatal config error ${response.statusCode} — deleting disk store`
            );
            await nativeDeleteSnapshot();
            this._hasDiskData = false;
            return;
          }

          case ResponseCategory.CLIENT_ERROR: {
            warn(
              `Disk drain: dropping batch due to client error ${response.statusCode}`
            );
            if (remaining.length === 0) {
              await nativeDeleteSnapshot();
              this._hasDiskData = false;
            } else {
              await writeSnapshot(
                JSON.stringify({
                  version: SNAPSHOT_VERSION,
                  events: remaining,
                })
              );
            }
            break;
          }
        }
      }
    } catch (err) {
      warn('Failed to drain disk to network:', err);
    }
  }

  /**
   * Delete the disk store (used during reset).
   */
  async deleteSnapshot(): Promise<void> {
    await nativeDeleteSnapshot();
    this._hasDiskData = false;
  }

  private async _readExistingEvents(): Promise<EventPayload[]> {
    const raw = await readSnapshot();
    if (!raw) return [];
    try {
      const snapshot: QueueSnapshot = JSON.parse(raw);
      if (
        snapshot.version === SNAPSHOT_VERSION &&
        Array.isArray(snapshot.events)
      ) {
        return snapshot.events;
      }
      return [];
    } catch {
      warn('Existing disk snapshot is corrupt JSON — overwriting');
      return [];
    }
  }
}

function filterExpired(events: EventPayload[]): EventPayload[] {
  const cutoff = Date.now() - DEFAULT_EVENT_TTL_MS;
  return events.filter((e) => {
    const ts = (e as any).timestamp;
    if (!ts) return true;
    const eventTime = new Date(ts).getTime();
    // Unparseable timestamp — keep it. Conservative: better to send than to
    // silently drop an event whose age we can't verify.
    if (isNaN(eventTime)) return true;
    return eventTime > cutoff;
  });
}

import { continuousMillis } from '../utils/monotonicClock';

export const DEFAULT_DEDUP_MAX_ENTRIES = 1_000;
export const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;

/**
 * Bounded record of recently seen bridge `messageId`s, with the iOS and
 * Android rules.
 *
 * Redelivery happens when the page re-posts after a lost ack, so a duplicate
 * can only arrive shortly after the original — entries older than the TTL
 * count as never seen. The size bound keeps a long-lived WebView from growing
 * the store forever; when full, the oldest entry goes first, being the least
 * likely to still be inside a redelivery window.
 *
 * In-memory only: a duplicate across a process restart is indistinguishable
 * from a fresh event and too rare to justify storage I/O on the message path.
 */
export class BridgeDedupStore {
  // Map iterates in insertion order, so the first key is the oldest entry.
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries: number = DEFAULT_DEDUP_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_DEDUP_TTL_MS,
    // Monotonic through sleep, so the window measures real elapsed time.
    private readonly clock: () => number = continuousMillis
  ) {
    if (!(maxEntries > 0)) throw new Error('maxEntries must be > 0');
    if (!(ttlMs > 0)) throw new Error('ttlMs must be > 0');
  }

  /**
   * Records `messageId` and reports whether it was new: true when unseen (or
   * seen only outside the TTL) — process it; false for a live duplicate — drop
   * it. A duplicate does NOT refresh the original timestamp: refreshing would
   * let a producer stuck in a re-post loop keep its entry alive forever.
   */
  markIfNew(messageId: string): boolean {
    const now = this.clock();
    const firstSeenAt = this.seen.get(messageId);
    if (firstSeenAt !== undefined && now - firstSeenAt < this.ttlMs) {
      return false;
    }
    // Delete before set so an expired entry moves to the back of the eviction
    // order instead of keeping its stale position.
    this.seen.delete(messageId);
    this.seen.set(messageId, now);
    if (this.seen.size > this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    return true;
  }

  /**
   * Removes a recorded id whose message never entered the delivery path —
   * left recorded, a legitimate producer retry would read as a duplicate of an
   * event that was actually lost.
   */
  forget(messageId: string): void {
    this.seen.delete(messageId);
  }

  size(): number {
    return this.seen.size;
  }
}

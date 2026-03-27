import type { EventPayload } from '../types';

/**
 * On-disk snapshot envelope for the event queue.
 * version is used for forward-compatible deserialization.
 */
export interface QueueSnapshot {
  version: number;
  events: EventPayload[];
}

/** Current snapshot schema version */
export const SNAPSHOT_VERSION = 1;

/** Flush-to-disk threshold: event count */
export const FLUSH_THRESHOLD_EVENTS = 500;

/** Flush-to-disk threshold: serialized size in bytes */
export const FLUSH_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2MB

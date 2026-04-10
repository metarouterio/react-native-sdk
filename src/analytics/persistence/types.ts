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

/** Default TTL for rehydrated events: 7 days in milliseconds */
export const DEFAULT_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Flush-to-disk threshold: approximate serialized size in bytes (~2MB) */
export const FLUSH_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** Flush-to-disk threshold: event count */
export const FLUSH_THRESHOLD_COUNT = 500;

/** Default max events stored on disk during extended offline periods */
export const DEFAULT_MAX_OFFLINE_DISK_EVENTS = 10_000;

/** Overflow buffer batch threshold: flush buffer to disk at this count */
export const OVERFLOW_BATCH_THRESHOLD = 100;

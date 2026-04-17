import type { EventPayload } from './types';
import type CircuitBreaker from './utils/circuitBreaker';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface NetworkResponse {
  statusCode: number;
}

export interface DispatcherOptions {
  maxEventCount: number; // event-count cap on memory queue (default 2000)
  maxQueueBytes: number; // byte-based cap on memory queue (~5MB default, internal)
  autoFlushThreshold: number; // e.g., 20
  maxBatchSize: number; // initial max; may shrink on 413
  flushIntervalSeconds: number;
  baseRetryDelayMs: number; // retry floor base delay (default 1000)
  maxRetryDelayMs: number; // retry floor cap (default 8000)

  /**
   * Whether disk persistence is enabled. When false, capacity overflow drops
   * the oldest event (ring buffer) instead of splicing the whole queue to
   * the onCapacityOverflow handler, since there is no disk to spill to.
   */
  isPersistenceEnabled: () => boolean;
  isNetworkAvailable: () => boolean; // returns false when offline

  endpoint: (path: string) => string;
  fetchWithTimeout: (
    url: string,
    init: RequestInit,
    timeoutMs: number
  ) => Promise<Response>;
  canSend: () => boolean; // lifecycle + identity preflight
  isOperational: () => boolean; // whether to requeue on retryable failure
  isTracingEnabled: () => boolean; // whether to include Trace header
  createBreaker: () => CircuitBreaker;

  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;

  onCapacityOverflow?: (events: EventPayload[]) => void; // called with entire queue when byte cap is hit — flushes to disk
  onFlushToDisk?: (events: EventPayload[]) => void; // called when flush triggers while offline — persists queue to disk
  onFlushComplete?: () => void; // fires after successful online flush to trigger disk drain
  onScheduleFlushIn?: (ms: number) => void; // optional notification for tests/metrics
  onFatalConfig?: () => void; // 401/403/404 handler
}

export default class Dispatcher {
  private readonly opts: DispatcherOptions;
  private readonly queue: EventPayload[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private nextTimer: NodeJS.Timeout | null = null;
  private nextScheduledAt: number | null = null;
  private flushInFlight: Promise<void> | null = null;
  private maxBatchSize: number;
  private readonly initialMaxBatchSize: number;
  private circuit: CircuitBreaker;
  private queueSizeBytes: number = 0;
  private consecutiveRetries: number = 0;

  constructor(opts: DispatcherOptions) {
    this.opts = opts;
    this.initialMaxBatchSize = Math.max(1, opts.maxBatchSize);
    this.maxBatchSize = this.initialMaxBatchSize;
    this.circuit = opts.createBreaker();
  }

  getQueueRef(): EventPayload[] {
    return this.queue;
  }

  /**
   * Drain the in-memory queue entirely. Returns all events and resets the
   * byte counter. Used by PersistentEventQueue to persist memory to disk
   * without leaving duplicates behind.
   */
  drainQueue(): EventPayload[] {
    const events = this.queue.splice(0);
    this.queueSizeBytes = 0;
    return events;
  }

  start(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(
      () => this.flush(),
      this.opts.flushIntervalSeconds * 1000
    );
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.clearNextTimer();
  }

  reset(): void {
    this.stop();
    this.queue.length = 0;
    this.queueSizeBytes = 0;
    this.consecutiveRetries = 0;
    this.circuit = this.opts.createBreaker();
    this.maxBatchSize = this.initialMaxBatchSize;
  }

  /**
   * Retry floor: exponential backoff independent of circuit breaker.
   * Applies from the very first failure so retries aren't immediate while circuit is closed.
   */
  private retryFloorMs(): number {
    if (this.consecutiveRetries <= 0) return 0;
    const exponent = Math.min(this.consecutiveRetries - 1, 10);
    return Math.min(
      this.opts.maxRetryDelayMs,
      this.opts.baseRetryDelayMs * Math.pow(2, exponent)
    );
  }

  private clearNextTimer(): void {
    if (this.nextTimer) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    this.nextScheduledAt = null;
  }

  scheduleFlushIn(ms: number): void {
    const target = Date.now() + Math.max(0, ms);
    if (this.nextScheduledAt && target >= this.nextScheduledAt - 25) return;
    if (this.nextTimer) clearTimeout(this.nextTimer);

    this.opts.onScheduleFlushIn?.(ms);

    this.nextScheduledAt = target;
    this.nextTimer = setTimeout(
      () => {
        this.nextScheduledAt = null;
        this.nextTimer = null;
        this.flush();
      },
      Math.max(0, ms)
    );
  }

  private static encoder = new TextEncoder();

  private estimateEventSize(event: EventPayload): number {
    return Dispatcher.encoder.encode(JSON.stringify(event)).byteLength;
  }

  private handleCapacityOverflow(triggerDesc: string): void {
    // Persistence disabled (maxDiskEvents === 0): ring-buffer — drop oldest
    // event one at a time instead of draining the whole queue, since there
    // is no disk to spill to.
    if (!this.opts.isPersistenceEnabled()) {
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        this.queueSizeBytes -= this.estimateEventSize(dropped);
        if (this.queueSizeBytes < 0) this.queueSizeBytes = 0;
        this.opts.warn(
          `Queue cap reached (${triggerDesc}) — dropped oldest event`
        );
      }
      return;
    }

    // Persistence enabled: splice the whole queue to the disk handler.
    if (this.opts.onCapacityOverflow) {
      const flushed = this.queue.splice(0);
      this.queueSizeBytes = 0;
      this.opts.onCapacityOverflow(flushed);
    } else {
      this.opts.warn(
        `Queue cap reached — dropping ${this.queue.length} event(s) (no overflow handler)`
      );
      this.queue.length = 0;
      this.queueSizeBytes = 0;
    }
  }

  private isOverCap(extraBytes: number = 0, extraCount: number = 0): boolean {
    return (
      this.queue.length + extraCount > this.opts.maxEventCount ||
      this.queueSizeBytes + extraBytes > this.opts.maxQueueBytes
    );
  }

  enqueue(event: EventPayload): void {
    const eventSize = this.estimateEventSize(event);

    // Enforce cap: if adding this event would exceed count OR byte limit,
    // flush/evict first so the new event still fits.
    while (this.queue.length > 0 && this.isOverCap(eventSize, 1)) {
      this.handleCapacityOverflow(
        this.queueSizeBytes + eventSize > this.opts.maxQueueBytes
          ? 'bytes'
          : 'count'
      );
      if (!this.opts.isPersistenceEnabled() && this.queue.length === 0) break;
      // When persistence IS enabled, handleCapacityOverflow drains the whole
      // queue so the loop exits naturally.
      if (this.opts.isPersistenceEnabled()) break;
    }

    this.opts.log(
      `Enqueuing event {"messageId": "${(event as any)?.messageId}", "type": "${(event as any)?.type}"}`
    );
    this.queue.push(event);
    this.queueSizeBytes += eventSize;
    this.opts.log(`Event enqueued, queue length: ${this.queue.length}`);

    if (this.queue.length >= this.opts.autoFlushThreshold) {
      void this.flush();
    }
  }

  enqueueFront(events: EventPayload[]): void {
    // Avoid spread into unshift — large arrays can exceed JS engine argument limit
    const merged = events.concat(this.queue);
    this.queue.length = 0;
    for (let i = 0; i < merged.length; i++) {
      this.queue.push(merged[i]);
    }
    for (const e of events) {
      this.queueSizeBytes += this.estimateEventSize(e);
    }

    // Enforce cap: drain to disk (or ring-buffer drop-oldest in 0-mode).
    while (this.isOverCap()) {
      const before = this.queue.length;
      this.handleCapacityOverflow(
        this.queueSizeBytes > this.opts.maxQueueBytes ? 'bytes' : 'count'
      );
      if (this.queue.length === before) break; // safety: avoid infinite loop
      if (this.opts.isPersistenceEnabled()) break; // drained entire queue
    }

    if (this.queue.length >= this.opts.autoFlushThreshold) {
      void this.flush();
    }
  }

  getQueueSizeBytes(): number {
    return this.queueSizeBytes;
  }

  private drainBatch(): EventPayload[] {
    const n = Math.min(this.queue.length, this.maxBatchSize);
    const nowIso = new Date().toISOString();
    const drained = this.queue.splice(0, n);
    const batch = drained.map((e) => {
      this.queueSizeBytes -= this.estimateEventSize(e);
      return { ...(e as any), sentAt: nowIso };
    });
    return batch;
  }

  private requeueChunk(chunk: EventPayload[]): void {
    // Avoid spread into unshift — large arrays can exceed JS engine argument limit
    const merged = chunk.concat(this.queue);
    this.queue.length = 0;
    for (let i = 0; i < merged.length; i++) {
      this.queue.push(merged[i]);
    }
    for (const e of chunk) {
      this.queueSizeBytes += this.estimateEventSize(e);
    }
  }

  private parseRetryAfter(h: string | null): number | null {
    if (!h) return null;
    const secs = Number(h);
    if (!Number.isNaN(secs)) return secs * 1000;
    const dateMs = Date.parse(h);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
  }

  async flush(): Promise<void> {
    if (!this.queue.length) return;
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.opts.canSend()) return;

    const doFlush = async () => {
      while (this.queue.length) {
        if (!this.opts.isNetworkAvailable()) {
          if (this.opts.onFlushToDisk && this.opts.isPersistenceEnabled()) {
            const flushed = this.queue.splice(0);
            this.queueSizeBytes = 0;
            this.opts.onFlushToDisk(flushed);
            this.opts.warn(
              `Offline — flushed ${flushed.length} event(s) to disk`
            );
          } else {
            this.opts.warn(
              `Offline — pausing HTTP attempts, ${this.queue.length} event(s) queued`
            );
          }
          return;
        }

        if (!this.circuit.allowRequest()) {
          const state = this.circuit.getState();
          const wait = this.circuit.remainingCooldownMs();
          this.opts.warn(
            `Circuit breaker ${state}, retrying in ${wait}ms (${this.queue.length} event(s) pending)`
          );
          this.scheduleFlushIn(wait);
          return;
        }

        const chunk = this.drainBatch();

        try {
          this.opts.log(
            `Making API call to: ${this.opts.endpoint('/v1/batch')}`
          );

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          if (this.opts.isTracingEnabled()) {
            headers.Trace = 'true';
          }

          const res = await this.opts.fetchWithTimeout(
            this.opts.endpoint('/v1/batch'),
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ batch: chunk }),
            },
            8000
          );

          if (!res.ok) {
            const s = res.status;

            // Retryable
            if (s >= 500 || s === 408) {
              this.circuit.onFailure();
              this.consecutiveRetries += 1;
              if (this.opts.isOperational()) {
                this.requeueChunk(chunk);
                const retryAfter =
                  this.parseRetryAfter(res.headers.get('retry-after')) ?? 0;
                const wait = Math.max(
                  this.retryFloorMs(),
                  this.circuit.remainingCooldownMs(),
                  retryAfter,
                  1000
                );
                this.opts.warn(
                  `Server error ${s}, will retry ${chunk.length} event(s) in ${wait}ms (circuit: ${this.circuit.getState()}, retry #${this.consecutiveRetries})`
                );
                this.scheduleFlushIn(wait);
              } else {
                this.opts.warn(
                  'Flush aborted during reset/disable — dropping current chunk'
                );
              }
              return;
            }

            if (s === 429) {
              this.circuit.onFailure();
              this.consecutiveRetries += 1;
              if (this.opts.isOperational()) {
                this.requeueChunk(chunk);
                const h =
                  this.parseRetryAfter(res.headers.get('retry-after')) ?? 0;
                const b = this.circuit.remainingCooldownMs();
                const wait = Math.max(this.retryFloorMs(), h, b, 1000);
                this.opts.warn(
                  `Rate limited (429), will retry ${chunk.length} event(s) in ${wait}ms (circuit: ${this.circuit.getState()}, retry #${this.consecutiveRetries})`
                );
                this.scheduleFlushIn(wait);
              } else {
                this.opts.warn(
                  'Throttle received but client resetting/disabled — dropping chunk'
                );
              }
              return;
            }

            if (s === 401 || s === 403 || s === 404) {
              this.opts.error(`Fatal config error ${s}. Disabling client.`);
              this.queue.length = 0;
              this.queueSizeBytes = 0;
              this.stop();
              this.opts.onFatalConfig?.();
              return;
            }

            if (s === 413) {
              this.circuit.onNonRetryable();
              if (this.maxBatchSize > 1) {
                this.maxBatchSize = Math.max(
                  1,
                  Math.floor(this.maxBatchSize / 2)
                );
                this.opts.warn(
                  `Payload too large; reducing maxBatchSize to ${this.maxBatchSize}`
                );
                this.requeueChunk(chunk);
                this.scheduleFlushIn(500);
              } else {
                const ids = (chunk as any[])
                  .map((e) => (e as any).messageId)
                  .join(',');
                this.opts.warn(
                  `Dropping oversize event(s) after 413 at batchSize=1; messageIds=${ids}`
                );
              }
              return;
            }

            // Other 4xx: drop bad payload
            this.circuit.onNonRetryable();
            this.opts.warn(`Dropping batch due to client error ${s}`);
            continue;
          }

          // Success
          this.circuit.onSuccess();
          this.consecutiveRetries = 0;
          if (this.maxBatchSize < this.initialMaxBatchSize) {
            this.maxBatchSize = Math.min(
              this.maxBatchSize * 2,
              this.initialMaxBatchSize
            );
          }
          this.opts.log('API call successful');

          // If queue is now empty after this successful batch, fire onFlushComplete
          if (this.queue.length === 0 && this.opts.isNetworkAvailable()) {
            this.opts.onFlushComplete?.();
          }
        } catch (err) {
          this.circuit.onFailure();
          this.consecutiveRetries += 1;
          if (this.opts.isOperational()) {
            this.requeueChunk(chunk);
            const wait = Math.max(
              this.retryFloorMs(),
              this.circuit.remainingCooldownMs(),
              1000
            );
            this.opts.warn(
              `API call failed: ${(err as any)?.message}, ${chunk.length} event(s) pending retry in ${wait}ms (circuit: ${this.circuit.getState()}, retry #${this.consecutiveRetries})`
            );
            this.scheduleFlushIn(wait);
          } else {
            this.opts.warn(
              'Flush failed during reset/disable — dropping current chunk'
            );
          }
          return;
        }
      }
    };

    this.flushInFlight = doFlush().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  resetCircuitBreaker(): void {
    this.circuit.reset();
    this.consecutiveRetries = 0;
  }

  /**
   * Send a batch directly to network, bypassing the memory queue.
   * Used by disk drain to flush overflow without loading into queue.
   * Returns { statusCode } on HTTP response, null on network/transport error.
   */
  async sendBatchDirect(
    events: EventPayload[]
  ): Promise<NetworkResponse | null> {
    try {
      const nowIso = new Date().toISOString();
      const batch = events.map((e) => ({ ...(e as any), sentAt: nowIso }));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.opts.isTracingEnabled()) {
        headers.Trace = 'true';
      }

      const res = await this.opts.fetchWithTimeout(
        this.opts.endpoint('/v1/batch'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ batch }),
        },
        8000
      );

      if (res.ok) {
        this.opts.log(`Direct batch send successful (${events.length} events)`);
      } else {
        this.opts.warn(`Direct batch send failed with status ${res.status}`);
      }

      return { statusCode: res.status };
    } catch (err) {
      this.opts.warn(`Direct batch send failed: ${(err as any)?.message}`);
      return null;
    }
  }

  getDebugInfo() {
    return {
      queueLength: this.queue.length,
      flushIntervalSeconds: this.opts.flushIntervalSeconds,
      proxy: false,
      flushInFlight: !!this.flushInFlight,
      circuitState: this.circuit.getState(),
      circuitRemainingMs: this.circuit.remainingCooldownMs(),
      maxQueueEvents: this.opts.maxEventCount,
      maxBatchSize: this.maxBatchSize,
      consecutiveRetries: this.consecutiveRetries,
      isNetworkAvailable: this.opts.isNetworkAvailable(),
    };
  }
}

import type { EventPayload } from "./types";
import type CircuitBreaker from "./utils/circuitBreaker";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface DispatcherOptions {
  maxQueueEvents: number;
  autoFlushThreshold: number; // e.g., 20
  maxBatchSize: number; // initial max; may shrink on 413
  flushIntervalSeconds: number;

  endpoint: (path: string) => string;
  fetchWithTimeout: (
    url: string,
    init: RequestInit,
    timeoutMs: number
  ) => Promise<Response>;
  canSend: () => boolean; // lifecycle + identity preflight
  isOperational: () => boolean; // whether to requeue on retryable failure
  createBreaker: () => CircuitBreaker;

  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;

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
  private circuit: CircuitBreaker;

  constructor(opts: DispatcherOptions) {
    this.opts = opts;
    this.maxBatchSize = Math.max(1, opts.maxBatchSize);
    this.circuit = opts.createBreaker();
  }

  getQueueRef(): EventPayload[] {
    return this.queue;
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
    this.circuit = this.opts.createBreaker();
    this.maxBatchSize = Math.max(1, this.opts.maxBatchSize);
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
    this.nextTimer = setTimeout(() => {
      this.nextScheduledAt = null;
      this.nextTimer = null;
      this.flush();
    }, Math.max(0, ms));
  }

  enqueue(event: EventPayload): void {
    // Hard cap: drop oldest until there's room
    while (this.queue.length >= this.opts.maxQueueEvents) {
      this.queue.shift();
      this.opts.warn(
        `[MetaRouter] Queue cap ${this.opts.maxQueueEvents} reached — dropped oldest event`
      );
    }

    this.opts.log("Enqueuing event", {
      type: (event as any)?.type,
      messageId: (event as any)?.messageId,
    });
    this.queue.push(event);

    if (this.queue.length >= this.opts.autoFlushThreshold) {
      this.opts.log(
        `Event queue reached ${this.opts.autoFlushThreshold}. Flushing queued events.`
      );
      void this.flush();
    }
  }

  private drainBatch(): EventPayload[] {
    const n = Math.min(this.queue.length, this.maxBatchSize);
    const nowIso = new Date().toISOString();
    const batch = this.queue.splice(0, n).map((e) => ({
      ...(e as any),
      sentAt: nowIso,
    }));
    return batch;
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
        if (!this.circuit.allowRequest()) {
          const state = this.circuit.getState();
          const wait = this.circuit.remainingCooldownMs();
          this.opts.log(`[MetaRouter] Circuit ${state} — skip; wait ${wait}ms`);
          this.scheduleFlushIn(wait);
          return;
        }

        const chunk = this.drainBatch();

        try {
          this.opts.log("Making API call to:", this.opts.endpoint("/v1/batch"));
          const res = await this.opts.fetchWithTimeout(
            this.opts.endpoint("/v1/batch"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ batch: chunk }),
            },
            8000
          );

          if (!res.ok) {
            const s = res.status;

            // Retryable
            if (s >= 500 || s === 408) {
              this.circuit.onFailure();
              if (this.opts.isOperational()) {
                this.queue.unshift(...chunk);
                const retryAfter =
                  this.parseRetryAfter(res.headers.get("retry-after")) ?? 0;
                const wait = Math.max(
                  this.circuit.remainingCooldownMs(),
                  retryAfter,
                  1000
                );
                this.opts.warn(
                  `Retryable status ${s}; scheduling retry in ${wait}ms`
                );
                this.scheduleFlushIn(wait);
              } else {
                this.opts.warn(
                  "Flush aborted during reset/disable — dropping current chunk"
                );
              }
              return;
            }

            if (s === 429) {
              this.circuit.onFailure();
              if (this.opts.isOperational()) {
                this.queue.unshift(...chunk);
                const h =
                  this.parseRetryAfter(res.headers.get("retry-after")) ?? 0;
                const b = this.circuit.remainingCooldownMs();
                const wait = Math.max(h, b, 1000);
                this.opts.warn(
                  `429 throttled; scheduling in ${wait}ms (retry-after=${h}, breaker=${b})`
                );
                this.scheduleFlushIn(wait);
              } else {
                this.opts.warn(
                  "Throttle received but client resetting/disabled — dropping chunk"
                );
              }
              return;
            }

            if (s === 401 || s === 403 || s === 404) {
              this.opts.error(`Fatal config error ${s}. Disabling client.`);
              this.queue.length = 0;
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
                this.queue.unshift(...chunk);
                this.scheduleFlushIn(500);
              } else {
                const ids = (chunk as any[])
                  .map((e) => (e as any).messageId)
                  .join(",");
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
          this.opts.log("API call successful");
        } catch (err) {
          this.circuit.onFailure();
          if (this.opts.isOperational()) {
            this.queue.unshift(...chunk);
            const wait = Math.max(this.circuit.remainingCooldownMs(), 1000);
            this.opts.warn(
              "Flush attempt failed; scheduling retry in",
              wait,
              "ms",
              (err as any)?.message
            );
            this.scheduleFlushIn(wait);
          } else {
            this.opts.warn(
              "Flush failed during reset/disable — dropping current chunk"
            );
          }
          return;
        }
      }

      this.opts.log("Flush completed successfully");
    };

    this.flushInFlight = doFlush().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  getDebugInfo() {
    return {
      queueLength: this.queue.length,
      flushIntervalSeconds: this.opts.flushIntervalSeconds,
      proxy: false,
      flushInFlight: !!this.flushInFlight,
      circuitState: this.circuit.getState(),
      circuitRemainingMs: this.circuit.remainingCooldownMs(),
      maxQueueEvents: this.opts.maxQueueEvents,
      maxBatchSize: this.maxBatchSize,
    };
  }
}

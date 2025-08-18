export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Failures in a row to trip OPEN */
  failureThreshold: number;
  /** Base cooldown when OPEN, ms */
  cooldownMs: number;
  /** Cap for exponential cooldown, ms (optional) */
  maxCooldownMs?: number;
  /** +- jitter ratio (0.0–0.5 recommended), e.g. 0.2 => ±20% */
  jitterRatio?: number;
  /** Allow at most N concurrent HALF_OPEN probes (usually 1) */
  halfOpenMaxConcurrent?: number;
  /** Optional clock (for tests) */
  now?: () => number;
}

export default class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly jitterRatio: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private state: CircuitState = "CLOSED";
  private openUntil = 0;
  private halfOpenInFlight = 0;
  private openCount = 0; // how many times we've opened (for exponential backoff)

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, opts.failureThreshold);
    this.baseCooldownMs = Math.max(0, opts.cooldownMs);
    this.maxCooldownMs = Math.max(
      this.baseCooldownMs,
      opts.maxCooldownMs ?? opts.cooldownMs * 8
    );
    this.jitterRatio = Math.min(Math.max(opts.jitterRatio ?? 0.2, 0), 0.5);
    this.halfOpenMaxConcurrent = Math.max(1, opts.halfOpenMaxConcurrent ?? 1);
    this.now = opts.now ?? Date.now;
  }

  /** Should we attempt a request right now? */
  allowRequest(): boolean {
    const t = this.now();

    if (this.state === "OPEN") {
      if (t >= this.openUntil) {
        // move to HALF_OPEN and allow limited probes
        this.state = "HALF_OPEN";
        this.halfOpenInFlight = 0;
      } else {
        return false;
      }
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) return false;
      this.halfOpenInFlight += 1;
      return true;
    }

    // CLOSED
    return true;
  }

  /** Call on successful request */
  onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      // success closes the breaker and resets counters
      this.state = "CLOSED";
      this.halfOpenInFlight = 0;
      this.openCount = 0;
    }
    this.consecutiveFailures = 0;
  }

  /** Call on failed request */
  onFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === "HALF_OPEN") {
      // failed probe -> re-open with backoff
      this.tripOpen();
      return;
    }

    if (
      this.state === "CLOSED" &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.tripOpen();
    }
  }

  /** Time when requests are next allowed (ms since epoch) */
  nextAllowedAt(): number {
    if (this.state === "OPEN") return this.openUntil;
    if (this.state === "HALF_OPEN") return this.now(); // a probe may be allowed immediately
    return this.now();
  }

  /** How long until next attempt (ms) */
  remainingCooldownMs(): number {
    const t = this.now();
    return Math.max(0, this.nextAllowedAt() - t);
  }

  /** Current state */
  getState(): CircuitState {
    // Normalize OPEN if time elapsed
    if (this.state === "OPEN" && this.now() >= this.openUntil)
      return "HALF_OPEN";
    return this.state;
  }

  private tripOpen() {
    this.state = "OPEN";
    this.halfOpenInFlight = 0;
    this.openCount += 1;

    // Exponential cooldown with cap + jitter
    const backoff = Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * 2 ** Math.max(0, this.openCount - 1)
    );
    const jitter = backoff * this.jitterRatio;
    const jittered = backoff + (Math.random() * 2 - 1) * jitter;

    this.openUntil = this.now() + Math.max(0, Math.floor(jittered));
  }
}

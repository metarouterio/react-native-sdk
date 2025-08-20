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
  /** Allow at most N concurrent HALF_OPEN probes (keep at 1 for simplicity/safety) */
  halfOpenMaxConcurrent?: number;
  /** Optional clock (for tests) */
  now?: () => number;
  /** Optional state transition hookP for logging/metrics */
  onStateChange?: (
    prev: CircuitState,
    next: CircuitState,
    meta: { failures: number; openCount: number; cooldownMs?: number }
  ) => void;
}

export default class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly jitterRatio: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly now: () => number;
  private readonly onStateChange?: CircuitBreakerOptions["onStateChange"];

  private consecutiveFailures = 0;
  private state: CircuitState = "CLOSED";
  private openUntil = 0;
  private halfOpenInFlight = 0;
  /** how many times we've opened (drives exponential backoff) */
  private openCount = 0;

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
    this.onStateChange = opts.onStateChange;
  }

  /** Should we attempt a request right now? */
  allowRequest(): boolean {
    const t = this.now();

    // Normalize OPEN→HALF_OPEN when cooldown elapsed
    if (this.state === "OPEN" && t >= this.openUntil) {
      this.halfOpenInFlight = 0;
      this.setState("HALF_OPEN");
    }

    if (this.state === "OPEN") {
      // Still cooling down
      return false;
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) return false;
      // Admit a probe
      this.halfOpenInFlight += 1;
      return true;
    }

    // CLOSED
    return true;
  }

  /** Call on successful request */
  onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      // One successful probe closes the circuit
      this.halfOpenInFlight = 0;
      this.openCount = 0;
      this.setState("CLOSED");
    }
    // Success in CLOSED resets the consecutive failure counter
    this.consecutiveFailures = 0;
  }

  /** Call on failed request (retryable only: network/timeout/5xx/etc.) */
  onFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === "HALF_OPEN") {
      // failed probe → re-open with backoff
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

  /** Optional: call for non‑retryable failures (4xx other than 429/413 policy) */
  onNonRetryable(): void {
    // Do not affect the breaker but clear the run of failures
    this.consecutiveFailures = 0;
  }

  /** Time when requests are next allowed (ms since epoch) */
  nextAllowedAt(): number {
    const t = this.now();
    if (this.state === "OPEN") return this.openUntil;
    if (this.state === "HALF_OPEN") {
      // Capacity-limited in HALF_OPEN; return now (admission depends on allowRequest())
      return t;
    }
    return t; // CLOSED
  }

  /** How long until next attempt (ms) */
  remainingCooldownMs(): number {
    const t = this.now();
    return Math.max(0, this.nextAllowedAt() - t);
  }

  /** Current state (normalized view: OPEN auto-shows HALF_OPEN after cooldown) */
  getState(): CircuitState {
    // Report HALF_OPEN if cooldown has elapsed,
    // but do not mutate state here — halfOpenInFlight
    // is reset when allowRequest() actually admits a probe.
    if (this.state === "OPEN" && this.now() >= this.openUntil) {
      return "HALF_OPEN";
    }
    return this.state;
  }

  // ---- internals ----

  private setState(next: CircuitState, meta: { cooldownMs?: number } = {}) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.onStateChange?.(prev, next, {
      failures: this.consecutiveFailures,
      openCount: this.openCount,
      cooldownMs: meta.cooldownMs,
    });
  }

  private tripOpen() {
    // Reset HALF_OPEN counters, move to OPEN, compute cooldown with jitter
    this.halfOpenInFlight = 0;

    // Cap exponent growth (cosmetic; avoids huge exponents)
    const maxExponent = Math.max(
      0,
      Math.ceil(
        Math.log2(this.maxCooldownMs / Math.max(1, this.baseCooldownMs))
      )
    );
    this.openCount = Math.min(this.openCount + 1, maxExponent + 1);

    const backoff = Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * 2 ** Math.max(0, this.openCount - 1)
    );
    const jitter = backoff * this.jitterRatio;
    const jittered = backoff + (Math.random() * 2 - 1) * jitter;
    const cooldown = Math.max(0, Math.floor(jittered));

    this.openUntil = this.now() + cooldown;
    this.setState("OPEN", { cooldownMs: cooldown });
  }
}

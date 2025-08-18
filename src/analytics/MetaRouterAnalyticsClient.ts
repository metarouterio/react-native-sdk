import { EventContext, EventPayload, InitOptions, Lifecycle } from "./types";
import { AppState, AppStateStatus } from "react-native";
import { log, setDebugLogging, warn, error } from "./utils/logger";
import { IdentityManager } from "./IdentityManager";
import { enrichEvent } from "./utils/enrichEvent";
import { getContextInfo } from "./utils/contextInfo";
import CircuitBreaker from "./utils/circuitBreaker";

/**
 * Analytics client for MetaRouter.
 * - Handles event queueing, batching, and delivery with retries.
 * - Manages user, group, and anonymous identity.
 * - Supports periodic and on-demand flushing.
 * - Provides debug and cleanup utilities.
 */
export class MetaRouterAnalyticsClient {
  private lifecycle: Lifecycle = "idle";
  private initPromise: Promise<void> | null = null;
  private queue: EventPayload[] = [];
  private flushIntervalMs = 10000;
  private flushTimer: NodeJS.Timeout | null = null;
  private ingestionHost: string;
  private writeKey: string;
  private context!: EventContext;
  private appState: AppStateStatus = AppState.currentState;
  private appStateSubscription: { remove?: () => void } | null = null;
  private identityManager: IdentityManager;
  private static readonly MAX_QUEUE_SIZE = 20;
  private flushInFlight: Promise<void> | null = null;
  private maxBatchSize = 100;
  private circuit!: CircuitBreaker;
  private nextTimer: NodeJS.Timeout | null = null;
  private nextScheduledAt: number | null = null;
  private maxQueueEvents: number;

  /**
   * Initializes the analytics client with the provided options.
   * @param options - The initialization options.
   */
  constructor(options: InitOptions) {
    log("Initializing analytics client", options);

    const { writeKey, ingestionHost, flushIntervalSeconds } = options;

    if (!writeKey || typeof writeKey !== "string" || writeKey.trim() === "") {
      throw new Error(
        "MetaRouterAnalyticsClient initialization failed: `writeKey` is required and must be a non-empty string."
      );
    }

    try {
      // Validate it's a proper absolute URL
      // and ensure it does not end with a trailing slash
      // e.g., "https://example.com" or "https://example.com/api" are valid,
      // but "https://example.com/" or "https://example.com/api/" are not.
      // eslint-disable-next-line no-new
      new URL(ingestionHost);
      if (ingestionHost.endsWith("/")) {
        throw new Error();
      }
    } catch {
      throw new Error(
        "MetaRouterAnalyticsClient initialization failed: `ingestionHost` must be a valid URL and not end in a slash."
      );
    }

    this.ingestionHost = ingestionHost;
    this.writeKey = writeKey;
    this.flushIntervalMs = flushIntervalSeconds
      ? flushIntervalSeconds * 1000
      : 10000;

    setDebugLogging(options.debug ?? false);
    this.identityManager = new IdentityManager();
    this.circuit = this.makeBreaker();
    this.maxQueueEvents = options.maxQueueEvents ?? 2000;
    log(
      "Analytics client constructor completed, initialization in progress..."
    );
  }

  /**
   * Initializes the analytics client.
   * @returns A promise that resolves when the client is initialized.
   */
  public async init() {
    if (this.lifecycle === "ready") {
      log("Analytics client already ready");
      return;
    }
    if (this.lifecycle === "initializing" && this.initPromise) {
      log("Analytics client initialization already in-flight");
      return this.initPromise;
    }

    if (this.lifecycle === "disabled") {
      warn("Analytics client is disabled — init skipped");
      return;
    }

    this.lifecycle = "initializing";
    log("Starting analytics client initialization...");

    this.initPromise = (async () => {
      try {
        await this.identityManager.init();
        log("IdentityManager initialized successfully");

        this.startFlushLoop();
        log("Flush loop started with interval:", this.flushIntervalMs, "ms");

        this.setupAppStateListener();
        log("App state listener setup completed");

        this.context = await getContextInfo();

        this.lifecycle = "ready";
        log("Analytics client initialization completed successfully");
      } catch (error) {
        this.lifecycle = "idle"; // allow retry
        warn("Analytics client initialization failed:", error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  private endpoint(path: string) {
    return `${this.ingestionHost}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /**
   * Starts the flush loop.
   */
  private startFlushLoop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  private isReady(): boolean {
    return this.lifecycle === "ready";
  }

  private makeBreaker() {
    return new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      maxCooldownMs: 120_000,
      jitterRatio: 0.2,
      halfOpenMaxConcurrent: 1,
    });
  }

  /**
   * Fetches with a timeout.
   * @param url - The URL to fetch.
   * @param init - The request init.
   * @param timeoutMs - The timeout in milliseconds.
   * @returns The response.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * Returns the current timestamp in ISO format.
   * @returns The current timestamp in ISO format.
   */
  private now() {
    return new Date().toISOString();
  }

  /**
   * Enqueues an event for processing.
   * @param event - The event to enqueue.
   */
  private enqueue(event: EventPayload) {
    if (!this.isReady()) {
      warn("Analytics client is not ready to operate");
      return;
    }

    const eventWithIdentity = this.identityManager.addIdentityInfo(event);
    const enrichedEvent = enrichEvent(
      eventWithIdentity,
      this.writeKey,
      this.context
    );

    // ⬇️ hard cap: drop OLDEST until there's room
    while (this.queue.length >= this.maxQueueEvents) {
      this.queue.shift();
      warn(
        `[MetaRouter] Queue cap ${this.maxQueueEvents} reached — dropped oldest event`
      );
    }

    log("Enqueuing event", {
      type: (enrichedEvent as any)?.type,
      messageId: (enrichedEvent as any)?.messageId,
    });
    this.queue.push(enrichedEvent);

    if (this.queue.length >= MetaRouterAnalyticsClient.MAX_QUEUE_SIZE) {
      log(
        `Event queue reached ${MetaRouterAnalyticsClient.MAX_QUEUE_SIZE}. Flushing queued events.`
      );
      this.flush();
    }
  }

  private drainBatch(): EventPayload[] {
    const n = Math.min(this.queue.length, this.maxBatchSize);
    const batch = this.queue
      .splice(0, n)
      .map((e) => ({ ...e, sentAt: this.now() }));
    return batch;
  }

  private scheduleFlushIn(ms: number) {
    const target = Date.now() + Math.max(0, ms);

    // If we already have a timer sooner or equal, keep it.
    if (this.nextScheduledAt && target >= this.nextScheduledAt - 25) return;

    // Otherwise, replace the existing timer with the earlier one.
    if (this.nextTimer) clearTimeout(this.nextTimer);

    this.nextScheduledAt = target;
    this.nextTimer = setTimeout(() => {
      this.nextScheduledAt = null;
      this.nextTimer = null;
      this.flush();
    }, Math.max(0, ms));
  }

  private stopFlushLoop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private parseRetryAfter(h: string | null): number | null {
    if (!h) return null;
    const secs = Number(h);
    if (!Number.isNaN(secs)) return secs * 1000;
    const dateMs = Date.parse(h);
    return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
  }

  /**
   * Sets up the app state listener.
   */
  private setupAppStateListener() {
    this.appStateSubscription = AppState.addEventListener(
      "change",
      this.handleAppStateChange
    );
  }

  /**
   * Handles the app state change event.
   * @param nextState - The new app state.
   */
  private handleAppStateChange = (nextState: AppStateStatus) => {
    if (this.appState === "active" && nextState.match(/inactive|background/)) {
      this.flush();
    }
    this.appState = nextState;
  };

  /**
   * Tracks an event.
   * @param event - The event to track.
   * @param properties - The properties to track.
   */
  track(event: string, properties?: Record<string, any>) {
    log("Tracking event:", event, "with properties:", properties);
    this.enqueue({ type: "track", event, properties, timestamp: this.now() });
    log("Event enqueued, queue length:", this.queue.length);
  }

  /**
   * Identifies a user.
   * @param userId - The user ID to identify.
   * @param traits - The traits to identify the user with.
   */
  identify(userId: string, traits?: Record<string, any>) {
    log("Identifying user:", userId, "with traits:", traits);
    this.identityManager.identify(userId);
    this.enqueue({ type: "identify", userId, traits, timestamp: this.now() });
    log("Identify event enqueued, queue length:", this.queue.length);
  }

  /**
   * Tracks a page view.
   * @param name - The name of the page.
   * @param properties - The properties to track.
   */
  page(name: string, properties?: Record<string, any>) {
    log("Tracking page:", name, "with properties:", properties);
    this.enqueue({
      type: "page",
      event: name,
      properties,
      timestamp: this.now(),
    });
    log("Page event enqueued, queue length:", this.queue.length);
  }

  /**
   * Groups a user.
   * @param groupId - The group ID to group.
   * @param traits - The traits to group the user with.
   */
  group(groupId: string, traits?: Record<string, any>) {
    log("Grouping user:", groupId, "with traits:", traits);
    this.identityManager.group(groupId);
    this.enqueue({ type: "group", groupId, traits, timestamp: this.now() });
    log("Group event enqueued, queue length:", this.queue.length);
  }

  /**
   * Tracks a screen view.
   * @param name - The name of the screen.
   * @param properties - The properties to track.
   */
  screen(name: string, properties?: Record<string, any>) {
    log("Tracking screen:", name, "with properties:", properties);
    this.enqueue({
      type: "screen",
      event: name,
      properties,
      timestamp: this.now(),
    });
    log("Screen event enqueued, queue length:", this.queue.length);
  }

  /**
   * Alias an anonymous user to a known user ID.
   * This updates internal identity state and enqueues an alias event.
   * @param newUserId - The new user ID to alias to.
   */
  alias(newUserId: string) {
    log("Aliasing user to:", newUserId);
    this.identityManager.identify(newUserId);
    this.enqueue({ type: "alias", userId: newUserId, timestamp: this.now() });
    log("Alias event enqueued, queue length:", this.queue.length);
  }

  /**
   * Enable debug logging for troubleshooting
   */
  enableDebugLogging() {
    setDebugLogging(true);
    log("Debug logging enabled");
  }

  /**
   * Get current state for debugging
   */
  async getDebugInfo() {
    const state = this.circuit.getState();
    return {
      lifecycle: this.lifecycle,
      queueLength: this.queue.length,
      ingestionHost: this.ingestionHost,
      writeKey: this.writeKey ? "***" + this.writeKey.slice(-4) : undefined,
      flushIntervalMs: this.flushIntervalMs,
      anonymousId: this.identityManager.getAnonymousId(),
      userId: this.identityManager.getUserId(),
      groupId: this.identityManager.getGroupId(),
      proxy: false,
      flushInFlight: !!this.flushInFlight,
      circuitState: state,
      circuitRemainingMs:
        state === "OPEN" ? this.circuit.remainingCooldownMs() : 0,
      maxQueueEvents: this.maxQueueEvents,
    };
  }

  /**
   * Flushes the event queue to the ingestion endpoint in chunks.
   * Singleflight: coalesces concurrent callers.
   */
  async flush() {
    if (!this.queue.length) return;
    if (this.flushInFlight) return this.flushInFlight;
    if (!this.isReady()) return;

    const anonId = this.identityManager.getAnonymousId();
    if (!anonId) {
      warn("Anonymous ID not yet ready, delaying flush");
      return;
    }

    const doFlush = async () => {
      // Keep sending while there is work. New events enqueued during the loop
      // will be included in this same flush cycle.
      while (this.queue.length) {
        if (!this.circuit.allowRequest()) {
          const wait = this.circuit.remainingCooldownMs();
          log(
            `[MetaRouter] Circuit ${this.circuit.getState()} — skip; wait ${wait}ms`
          );
          this.scheduleFlushIn(wait);
          return;
        }

        const chunk = this.drainBatch();

        try {
          log("Making API call to:", this.endpoint("/v1/batch"));
          const res = await this.fetchWithTimeout(
            this.endpoint("/v1/batch"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ batch: chunk }),
            },
            8000
          );

          if (!res.ok) {
            const s = res.status;

            // Retryable (do NOT throw; mark failure once and schedule)
            if (s >= 500 || s === 408) {
              this.circuit.onFailure();
              // ⬇️ Only requeue/schedule if still operable
              if (this.isReady()) {
                this.queue.unshift(...chunk);
                const retryAfter =
                  this.parseRetryAfter(res.headers.get("retry-after")) ?? 0;
                const wait = Math.max(
                  this.circuit.remainingCooldownMs(),
                  retryAfter,
                  1000
                );
                warn(`Retryable status ${s}; scheduling retry in ${wait}ms`);
                this.scheduleFlushIn(wait);
              } else {
                warn(
                  "Flush aborted during reset/disable — dropping current chunk"
                );
              }
              return;
            }

            if (s === 429) {
              this.circuit.onFailure();
              if (this.isReady()) {
                this.queue.unshift(...chunk);
                const h =
                  this.parseRetryAfter(res.headers.get("retry-after")) ?? 0;
                const b = this.circuit.remainingCooldownMs();
                const wait = Math.max(h, b, 1000);
                warn(
                  `429 throttled; scheduling in ${wait}ms (retry-after=${h}, breaker=${b})`
                );
                this.scheduleFlushIn(wait);
              } else {
                warn(
                  "Throttle received but client resetting/disabled — dropping chunk"
                );
              }
              return;
            }

            // Fatal config
            if (s === 401 || s === 403 || s === 404) {
              this.circuit.onSuccess(); // cluster reachable
              error(`Fatal config error ${s}. Disabling client.`);
              this.lifecycle = "disabled";
              this.queue = [];
              this.stopFlushLoop();
              return;
            }

            // Too large: shrink batch and retry later
            if (s === 413) {
              this.circuit.onSuccess(); // reachable
              if (this.maxBatchSize > 1) {
                this.maxBatchSize = Math.max(
                  1,
                  Math.floor(this.maxBatchSize / 2)
                );
                warn(
                  `Payload too large; reducing maxBatchSize to ${this.maxBatchSize}`
                );
                this.queue.unshift(...chunk);
                this.scheduleFlushIn(500);
              } else {
                // Single event still too large — drop with signal
                const ids = (chunk as any[]).map((e) => e.messageId).join(",");
                warn(
                  `Dropping oversize event(s) after 413 at batchSize=1; messageIds=${ids}`
                );
              }
              return;
            }
            // Other 4xx: drop bad payload
            this.circuit.onSuccess(); // reachable; don't accumulate failures
            warn(`Dropping batch due to client error ${s}`);
            continue;
          }

          // Success path
          this.circuit.onSuccess();
          log("API call successful");
          // continue loop to send next chunk
        } catch (err) {
          // Network/timeout/abort -> single failure mark
          this.circuit.onFailure();
          if (this.isReady()) {
            this.queue.unshift(...chunk);
            const wait = Math.max(this.circuit.remainingCooldownMs(), 1000);
            warn(
              "Flush attempt failed; scheduling retry in",
              wait,
              "ms",
              (err as any)?.message
            );
            this.scheduleFlushIn(wait);
          } else {
            warn("Flush failed during reset/disable — dropping current chunk");
          }
          return;
        }
      }

      log("Flush completed successfully");
    };

    this.flushInFlight = doFlush().finally(() => {
      this.flushInFlight = null;
    });

    return this.flushInFlight;
  }

  /**
   * Resets the analytics client.
   */
  public async reset(): Promise<void> {
    log("Resetting analytics client");

    // Flip lifecycle first so other paths see we're resetting
    this.lifecycle = "resetting";

    // Stop background work
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;

    this.queue = [];
    this.circuit = this.makeBreaker();

    // Clear identity (must remove persisted IDs)
    await this.identityManager.reset();

    // Allow a clean future init
    this.initPromise = null;

    // Back to idle: explicit init required
    this.lifecycle = "idle";

    log("Analytics client reset complete");
  }
}

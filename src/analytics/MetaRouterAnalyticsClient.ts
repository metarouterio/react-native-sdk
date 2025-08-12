import { EventContext, EventPayload, InitOptions, Lifecycle } from "./types";
import { AppState, AppStateStatus } from "react-native";
import { retryWithBackoff } from "./utils/retry";
import { error, log, setDebugLogging, warn } from "./utils/logger";
import { IdentityManager } from "./IdentityManager";
import { enrichEvent } from "./utils/enrichEvent";
import { getContextInfo } from "./utils/contextInfo";

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
  private readonly MAX_BATCH_SIZE = 100;

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

  /**
   * Checks if the analytics client can operate.
   * @returns True if the client is ready to operate, false otherwise.
   */
  private canOperate() {
    return this.lifecycle === "ready";
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
    // All calls route via proxy; direct calls pre‑ready are intentionally dropped
    if (!this.canOperate()) {
      warn("Analytics client is not ready to operate");
      return;
    }

    const eventWithIdentity = this.identityManager.addIdentityInfo(event);
    const enrichedEvent = enrichEvent(
      eventWithIdentity,
      this.writeKey,
      this.context
    );
    log("Enqueuing event", enrichedEvent);
    this.queue.push(enrichedEvent);

    if (this.queue.length >= MetaRouterAnalyticsClient.MAX_QUEUE_SIZE) {
      log(
        `Event queue reached max size (${MetaRouterAnalyticsClient.MAX_QUEUE_SIZE}). Flushing queued events.`
      );
      this.flush();
    }
  }

  private drainBatch(): EventPayload[] {
    const n = Math.min(this.queue.length, this.MAX_BATCH_SIZE);
    const batch = this.queue
      .splice(0, n)
      .map((e) => ({ ...e, sentAt: this.now() }));
    return batch;
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
    };
  }

  /**
   * Flushes the event queue to the ingestion endpoint in chunks.
   * Singleflight: coalesces concurrent callers.
   */
  async flush() {
    if (!this.canOperate()) return;
    if (!this.queue.length) return;
    if (this.flushInFlight) return this.flushInFlight;

    const anonId = this.identityManager.getAnonymousId();
    if (!anonId) {
      warn("Anonymous ID not yet ready, delaying flush");
      return;
    }

    const doFlush = async () => {
      // Keep sending while there is work. New events enqueued during the loop
      // will be included in this same flush cycle.
      while (this.queue.length) {
        const chunk = this.drainBatch();

        // Retry this *chunk* only; on permanent failure, requeue it and abort.
        await retryWithBackoff(
          async () => {
            if (!this.canOperate())
              throw new Error("Client not ready during flush");

            log("Making API call to:", this.endpoint("/v1/batch"));

            const response = await this.fetchWithTimeout(
              this.endpoint("/v1/batch"),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ batch: chunk }),
              },
              8000
            );

            if (!response.ok) {
              error("HTTP error", response.status, response.statusText);
              throw new Error(
                `HTTP ${response.status}: ${response.statusText}`
              );
            }

            log("API call successful, status:", response.status);
          },
          {
            retries: 5,
            baseDelayMs: 1000,
            shouldContinue: () => this.canOperate(),
          }
        ).catch((err) => {
          // Only requeue if the client is still operable; otherwise drop.
          if (this.canOperate()) {
            warn("Flush failed, re-queueing current chunk", err);
            this.queue.unshift(...chunk);
          } else {
            warn(
              "Flush failed during reset/teardown; dropping current chunk",
              err
            );
          }
          throw err;
        });
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

    // Drop queued events
    this.queue = [];

    // Clear identity (must remove persisted IDs)
    await this.identityManager.reset();

    // Allow a clean future init
    this.initPromise = null;

    // Back to idle: explicit init required
    this.lifecycle = "idle";

    log("Analytics client reset complete");
  }
}

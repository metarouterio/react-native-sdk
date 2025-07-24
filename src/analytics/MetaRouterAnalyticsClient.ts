import {
  EventContext,
  EventPayload,
  InitOptions,
} from "./types";
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
  private initialized = false;
  private initPromise: Promise<void>;
  private queue: EventPayload[] = [];
  private flushIntervalMs = 10000;
  private flushTimer: NodeJS.Timeout | null = null;
  private ingestionHost: string;
  private writeKey: string;
  private context!: EventContext;
  private appState: AppStateStatus = AppState.currentState;
  private appStateSubscription: { remove?: () => void } | null = null;
  private identityManager: IdentityManager;

  /**
   * Initializes the analytics client with the provided options.
   * @param options - The initialization options.
   */
  constructor(options: InitOptions) {
    log("Initializing analytics client", options);
    const { writeKey, ingestionHost, flushInterval } = options;
    this.ingestionHost = ingestionHost;
    this.writeKey = writeKey;
    this.flushIntervalMs = flushInterval ?? 10000;
    setDebugLogging(options.debug ?? false);
    this.identityManager = new IdentityManager();
    this.initPromise = this.init();
    log(
      "Analytics client constructor completed, initialization in progress..."
    );
  }

  /**
   * Initializes the analytics client.
   * @returns A promise that resolves when the client is initialized.
   */
  private async init() {
    if (this.initialized) {
      log("Analytics client already initialized");
      return;
    }

    log("Starting analytics client initialization...");

    try {
      await this.identityManager.init();
      log("IdentityManager initialized successfully");

      this.startFlushLoop();
      log("Flush loop started with interval:", this.flushIntervalMs, "ms");

      this.setupAppStateListener();
      log("App state listener setup completed");

      this.context = await getContextInfo();

      this.initialized = true;
      log("Analytics client initialization completed successfully");
    } catch (error) {
      warn("Analytics client initialization failed:", error);
      // Still mark as initialized to prevent infinite retries
      this.initialized = true;
      throw error;
    }
  }

  /**
   * Waits for the analytics client to be initialized.
   * @returns A promise that resolves when the client is initialized.
   */
  async waitForInitialization(): Promise<void> {
    await this.initPromise;
  }

  /**
   * Starts the flush loop.
   */
  private startFlushLoop() {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
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
    const eventWithIdentity = this.identityManager.addIdentityInfo(event);
    const enrichedEvent = enrichEvent(
      eventWithIdentity,
      this.writeKey,
      this.context
    );
    log("Enqueuing event", enrichedEvent);
    this.queue.push(enrichedEvent);
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
  getDebugInfo() {
    return {
      initialized: this.initialized,
      queueLength: this.queue.length,
      ingestionHost: this.ingestionHost,
      writeKey: this.writeKey ? "***" + this.writeKey.slice(-4) : undefined,
      flushIntervalMs: this.flushIntervalMs,
      anonymousId: this.identityManager.getAnonymousId(),
      userId: this.identityManager.getUserId(),
      groupId: this.identityManager.getGroupId(),
    };
  }

  /**
   * Flushes the event queue to the ingestion endpoint.
   */
  async flush() {
    const anonId = this.identityManager.getAnonymousId();
    if (!anonId) {
      warn("Anonymous ID not yet ready, delaying flush");
      // Anon ID not yet ready, delay flushing
      return;
    }

    if (this.queue.length === 0) {
      log("No events to flush");
      return;
    }

    const batch = this.queue.map((event) => ({
      ...event,
      sentAt: new Date().toISOString(),
    }));

    this.queue = [];

    log(`Flushing ${batch.length} events to ${this.ingestionHost}/v1/batch`);

    try {
      await retryWithBackoff(async () => {
        log("Making API call to:", this.ingestionHost + "/v1/batch");
        const response = await fetch(this.ingestionHost + "/v1/batch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ batch }),
        });

        if (!response.ok) {
          error("HTTP error", response);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        log("API call successful, status:", response.status);
        return response;
      });

      log("Flush completed successfully");
      return batch;
    } catch (err) {
      warn("Flush failed, re-queueing events", err);
      this.queue.unshift(...batch);
    }
  }

  /**
   * Resets the analytics client.
   */
  reset() {
    this.identityManager.reset();
    this.queue = [];
    log("Analytics client reset");
  }

  /**
   * Cleans up the analytics client.
   */
  cleanup() {
    log("Cleaning up analytics client");
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.queue = [];
    this.flushTimer = null;
    this.appStateSubscription?.remove?.();
  }
}

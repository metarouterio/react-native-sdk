import { EventContext, EventPayload, InitOptions, Lifecycle } from './types';
import { AppState, AppStateStatus } from 'react-native';
import { log, setDebugLogging, warn, error } from './utils/logger';
import { IdentityManager } from './IdentityManager';
import { enrichEvent } from './utils/enrichEvent';
import { getContextInfo, clearContextCache } from './utils/contextInfo';
import {
  getIdentityField,
  setIdentityField,
  removeIdentityField,
  ADVERTISING_ID_KEY,
} from './utils/identityStorage';
import CircuitBreaker from './utils/circuitBreaker';
import Dispatcher from './dispatcher';
import { PersistentEventQueue } from './persistence/PersistentEventQueue';
import type {
  NetworkReachability,
  NetworkStatus,
} from './network/NetworkReachability';

const ONLINE_DEBOUNCE_MS = 2_000;

export interface AnalyticsClientDeps {
  networkMonitor?: NetworkReachability;
}

/**
 * Analytics client for MetaRouter.
 * - Handles event queueing, batching, and delivery with retries.
 * - Manages user, group, and anonymous identity.
 * - Supports periodic and on-demand flushing.
 * - Provides debug and cleanup utilities.
 */
export class MetaRouterAnalyticsClient {
  private lifecycle: Lifecycle = 'idle';
  private initPromise: Promise<void> | null = null;
  private queue: EventPayload[] = [];
  private flushIntervalSeconds = 10;
  private ingestionHost: string;
  private writeKey: string;
  private context!: EventContext;
  private appState: AppStateStatus = AppState.currentState;
  private appStateSubscription: { remove?: () => void } | null = null;
  private identityManager: IdentityManager;
  private static readonly MAX_QUEUE_SIZE = 20;
  private maxQueueBytes: number = 5 * 1024 * 1024; // 5MB default
  private dispatcher!: Dispatcher;
  private persistentQueue!: PersistentEventQueue;
  private tracingEnabled: boolean = false;
  private networkMonitor: NetworkReachability | null = null;
  private networkStatus: NetworkStatus = 'connected';
  private onlineDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeNetwork: (() => void) | null = null;

  /**
   * Initializes the analytics client with the provided options.
   * @param options - The initialization options.
   */
  constructor(options: InitOptions, deps?: AnalyticsClientDeps) {
    const { writeKey, ingestionHost, flushIntervalSeconds } = options;

    if (!writeKey || typeof writeKey !== 'string' || writeKey.trim() === '') {
      throw new Error(
        'MetaRouterAnalyticsClient initialization failed: `writeKey` is required and must be a non-empty string.'
      );
    }

    try {
      // Validate it's a proper absolute URL
      // and ensure it does not end with a trailing slash
      // e.g., "https://example.com" or "https://example.com/api" are valid,
      // but "https://example.com/" or "https://example.com/api/" are not.
      // eslint-disable-next-line no-new
      new URL(ingestionHost);
      if (ingestionHost.endsWith('/')) {
        throw new Error();
      }
    } catch {
      throw new Error(
        'MetaRouterAnalyticsClient initialization failed: `ingestionHost` must be a valid URL and not end in a slash.'
      );
    }

    this.ingestionHost = ingestionHost;
    this.writeKey = writeKey;
    this.flushIntervalSeconds = flushIntervalSeconds ?? 10;

    setDebugLogging(options.debug ?? false);
    this.identityManager = new IdentityManager();
    this.maxQueueBytes = options.maxQueueBytes ?? this.maxQueueBytes;
    this.dispatcher = new Dispatcher({
      maxQueueBytes: this.maxQueueBytes,
      autoFlushThreshold: MetaRouterAnalyticsClient.MAX_QUEUE_SIZE,
      maxBatchSize: 100,
      flushIntervalSeconds: this.flushIntervalSeconds,
      baseRetryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      endpoint: (path) => this.endpoint(path),
      fetchWithTimeout: (url, init, timeoutMs) =>
        this.fetchWithTimeout(url, init, timeoutMs),
      canSend: () =>
        this.lifecycle === 'ready' &&
        !!this.identityManager.getAnonymousId() &&
        this.networkStatus === 'connected',
      isOperational: () => this.lifecycle === 'ready',
      isTracingEnabled: () => this.tracingEnabled,
      createBreaker: () =>
        new CircuitBreaker({
          failureThreshold: 3,
          cooldownMs: 10_000,
          maxCooldownMs: 120_000,
          jitterRatio: 0.2,
          halfOpenMaxConcurrent: 1,
          onStateChange: (prev, next, meta) => {
            log(
              `[MetaRouter] Circuit ${prev} → ${next}` +
                (meta.cooldownMs != null
                  ? ` (cooldown=${meta.cooldownMs}ms)`
                  : ''),
              { failures: meta.failures, openCount: meta.openCount }
            );
          },
        }),
      log,
      warn,
      error,
      onScheduleFlushIn: (ms) => {
        (this as any).scheduleFlushIn(ms, { fromDispatcher: true });
      },
      onFatalConfig: () => {
        this.lifecycle = 'disabled';
      },
    });

    this.queue = this.dispatcher.getQueueRef();
    this.persistentQueue = new PersistentEventQueue(this.dispatcher);
    this.networkMonitor = deps?.networkMonitor ?? null;
  }

  /**
   * Initializes the analytics client.
   * @returns A promise that resolves when the client is initialized.
   */
  public async init() {
    if (this.lifecycle === 'ready') {
      log('Analytics client already ready');
      return;
    }
    if (this.lifecycle === 'initializing' && this.initPromise) {
      log('Analytics client initialization already in-flight');
      return this.initPromise;
    }

    if (this.lifecycle === 'disabled') {
      warn('Analytics client is disabled — init skipped');
      return;
    }

    this.lifecycle = 'initializing';

    this.initPromise = (async () => {
      try {
        await this.identityManager.init();

        await this.persistentQueue.rehydrate();

        this.startFlushLoop();
        this.setupAppStateListener();

        // Load persisted advertising ID if available
        const persistedAdvertisingId =
          await getIdentityField(ADVERTISING_ID_KEY);

        this.context = await getContextInfo(
          persistedAdvertisingId || undefined
        );

        this.lifecycle = 'ready';
        this.setupNetworkMonitor();
        log('MetaRouter SDK initialized');

        // Flush immediately so rehydrated events ship on cold start
        // (AppState 'change' won't fire because the app is already active)
        void this.flush();
      } catch (error) {
        this.lifecycle = 'idle'; // allow retry
        warn('Analytics client initialization failed:', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  private endpoint(path: string) {
    return `${this.ingestionHost}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Starts the flush loop.
   */
  private startFlushLoop() {
    this.dispatcher.start();
  }

  private setupNetworkMonitor(): void {
    if (!this.networkMonitor) return;

    this.unsubscribeNetwork = this.networkMonitor.onStatusChange((status) => {
      const wasOffline = this.networkStatus === 'disconnected';

      if (status === 'disconnected') {
        // Offline: act immediately, cancel any pending online debounce
        if (this.onlineDebounceTimer) {
          clearTimeout(this.onlineDebounceTimer);
          this.onlineDebounceTimer = null;
        }
        this.networkStatus = status;
        log('Network connectivity lost — pausing HTTP attempts');
      } else if (wasOffline && status === 'connected') {
        // Online: debounce — only act after connectivity is stable for 2s
        log('Network connectivity detected — debouncing for stability');
        if (this.onlineDebounceTimer) {
          clearTimeout(this.onlineDebounceTimer);
        }
        this.onlineDebounceTimer = setTimeout(() => {
          this.onlineDebounceTimer = null;
          this.networkStatus = status;
          log('Network connectivity stable — resuming flush');
          this.dispatcher.resetCircuitBreaker();
          void this.flush();
        }, ONLINE_DEBOUNCE_MS);
      }
    });
  }

  private isReady(): boolean {
    return this.lifecycle === 'ready';
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
      warn('Analytics client is not ready to operate');
      return;
    }

    const eventWithIdentity = this.identityManager.addIdentityInfo(event);
    const enrichedEvent = enrichEvent(
      eventWithIdentity,
      this.writeKey,
      this.context
    );

    this.dispatcher.enqueue(enrichedEvent);

    // Check if we should flush to disk based on thresholds
    if (this.persistentQueue.shouldFlushToDisk()) {
      void this.persistentQueue.flushToDisk();
    }
  }

  private scheduleFlushIn(ms: number, opts?: { fromDispatcher?: boolean }) {
    if (opts?.fromDispatcher) return;
    this.dispatcher.scheduleFlushIn(ms);
  }

  private stopFlushLoop() {
    this.dispatcher.stop();
  }

  private clearNextTimer() {
    // Timers owned by dispatcher
  }

  /**
   * Sets up the app state listener.
   */
  private setupAppStateListener() {
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange
    );
  }

  /**
   * Handles the app state change event.
   * @param nextState - The new app state.
   */
  private handleAppStateChange = async (nextState: AppStateStatus) => {
    if (this.appState === 'active' && nextState.match(/inactive|background/)) {
      log('App moved to background');
      this.stopFlushLoop();
      this.clearNextTimer();
      await this.flush();
      await this.persistentQueue.flushToDisk();
    }
    if (nextState === 'active' && this.lifecycle === 'ready') {
      log('App moved to foreground');
      this.startFlushLoop();
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
    this.enqueue({ type: 'track', event, properties, timestamp: this.now() });
  }

  /**
   * Identifies a user.
   * @param userId - The user ID to identify.
   * @param traits - The traits to identify the user with.
   */
  identify(userId: string, traits?: Record<string, any>) {
    this.identityManager.identify(userId);
    this.enqueue({ type: 'identify', userId, traits, timestamp: this.now() });
  }

  /**
   * Tracks a page view.
   * @param name - The name of the page.
   * @param properties - The properties to track.
   */
  page(name: string, properties?: Record<string, any>) {
    this.enqueue({
      type: 'page',
      event: name,
      properties,
      timestamp: this.now(),
    });
  }

  /**
   * Groups a user.
   * @param groupId - The group ID to group.
   * @param traits - The traits to group the user with.
   */
  group(groupId: string, traits?: Record<string, any>) {
    this.identityManager.group(groupId);
    this.enqueue({ type: 'group', groupId, traits, timestamp: this.now() });
  }

  /**
   * Tracks a screen view.
   * @param name - The name of the screen.
   * @param properties - The properties to track.
   */
  screen(name: string, properties?: Record<string, any>) {
    this.enqueue({
      type: 'screen',
      event: name,
      properties,
      timestamp: this.now(),
    });
  }

  /**
   * Alias an anonymous user to a known user ID.
   * This updates internal identity state and enqueues an alias event.
   * @param newUserId - The new user ID to alias to.
   */
  alias(newUserId: string) {
    this.identityManager.identify(newUserId);
    this.enqueue({ type: 'alias', userId: newUserId, timestamp: this.now() });
  }

  /**
   * Sets the advertising identifier for ad tracking and attribution.
   * This will update the context for all subsequent events and persist it to storage.
   *
   * ⚠️ Important: Advertising identifiers are Personally Identifiable Information (PII).
   * You must obtain user consent before collecting advertising IDs and comply with
   * GDPR, CCPA, and App Store privacy requirements.
   *
   * @param advertisingId - The advertising identifier (IDFA on iOS, GAID on Android)
   */
  async setAdvertisingId(advertisingId: string) {
    if (!this.isReady()) {
      warn(
        'Analytics client is not ready. Call init() before setAdvertisingId()'
      );
      return;
    }

    if (
      !advertisingId ||
      typeof advertisingId !== 'string' ||
      advertisingId.trim() === ''
    ) {
      warn('Invalid advertising ID provided. Must be a non-empty string.');
      return;
    }

    log('Setting advertising ID');
    await setIdentityField(ADVERTISING_ID_KEY, advertisingId);
    clearContextCache();
    this.context = await getContextInfo(advertisingId);
    log('Advertising ID updated, persisted, and context refreshed');
  }

  /**
   * Clears the advertising identifier from storage and context.
   * Use this method when users opt out of ad tracking or revoke consent.
   *
   * This is useful for GDPR/CCPA compliance when users want to stop sharing
   * their advertising ID without performing a full analytics reset.
   */
  async clearAdvertisingId() {
    if (!this.isReady()) {
      warn(
        'Analytics client is not ready. Call init() before clearAdvertisingId()'
      );
      return;
    }

    log('Clearing advertising ID');
    await removeIdentityField(ADVERTISING_ID_KEY);
    clearContextCache();
    this.context = await getContextInfo();
    log('Advertising ID cleared from storage and context');
  }

  /**
   * Enable or disable tracing headers on outgoing requests.
   * When enabled, a "Trace: true" header is included in all API calls to the cluster.
   * This is useful for debugging and troubleshooting request flows.
   *
   * @param enabled - Whether to enable tracing headers
   */
  setTracing(enabled: boolean) {
    log(`Tracing ${enabled ? 'enabled' : 'disabled'}`);
    this.tracingEnabled = enabled;
  }

  /**
   * Returns whether tracing is currently enabled.
   * @returns True if tracing is enabled
   */
  isTracingEnabled(): boolean {
    return this.tracingEnabled;
  }

  /**
   * Enable debug logging for troubleshooting
   */
  enableDebugLogging() {
    setDebugLogging(true);
    log('Debug logging enabled');
  }

  /**
   * Get current state for debugging
   */
  async getDebugInfo() {
    const d = this.dispatcher.getDebugInfo();
    return {
      lifecycle: this.lifecycle,
      queueLength: d.queueLength,
      ingestionHost: this.ingestionHost,
      writeKey: this.writeKey ? '***' + this.writeKey.slice(-4) : undefined,
      flushIntervalSeconds: this.flushIntervalSeconds,
      anonymousId: this.identityManager.getAnonymousId(),
      userId: this.identityManager.getUserId(),
      groupId: this.identityManager.getGroupId(),
      proxy: false,
      flushInFlight: d.flushInFlight,
      circuitState: d.circuitState,
      circuitRemainingMs: d.circuitRemainingMs,
      maxQueueBytes: d.maxQueueBytes,
      tracingEnabled: this.tracingEnabled,
      networkStatus: this.networkStatus,
      rehydratedEvents: this.persistentQueue.rehydratedEvents,
    };
  }

  /**
   * Flushes the event queue to the ingestion endpoint in chunks.
   * Singleflight: coalesces concurrent callers.
   */
  async flush() {
    return this.dispatcher.flush();
  }

  /**
   * Resets the analytics client.
   */
  public async reset(): Promise<void> {
    log('Resetting analytics client');

    // Flip lifecycle first so other paths see we're resetting
    this.lifecycle = 'resetting';

    // Stop network monitoring and cancel pending debounce
    if (this.onlineDebounceTimer) {
      clearTimeout(this.onlineDebounceTimer);
      this.onlineDebounceTimer = null;
    }
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    this.networkMonitor?.stop();

    // Stop background work
    this.dispatcher.stop();
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;

    this.dispatcher.reset();
    await this.persistentQueue.deleteSnapshot();

    // Clear identity (must remove persisted IDs)
    await this.identityManager.reset();

    // Clear advertising ID from storage
    await removeIdentityField(ADVERTISING_ID_KEY);

    // Allow a clean future init
    this.initPromise = null;

    // Back to idle: explicit init required
    this.lifecycle = 'idle';
    this.clearNextTimer();

    log('Analytics client reset complete');
  }
}

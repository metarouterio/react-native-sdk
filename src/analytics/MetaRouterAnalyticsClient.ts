import {
  EnrichedEventPayload,
  EventContext,
  EventPayload,
  InitOptions,
  Lifecycle,
} from './types';
import { AppState, AppStateStatus } from 'react-native';
import { log, setDebugLogging, warn, error } from './utils/logger';
import { IdentityManager } from './IdentityManager';
import { enrichEvent } from './utils/enrichEvent';
import { getContextInfo, clearContextCache } from './utils/contextInfo';
import { AppContext, loadAppContext } from './utils/appContext';
import {
  getIdentityField,
  setIdentityField,
  removeIdentityField,
  ADVERTISING_ID_KEY,
  ANONYMOUS_ID_KEY,
  USER_ID_KEY,
  GROUP_ID_KEY,
} from './utils/identityStorage';
import {
  getLifecycleVersion,
  getLifecycleBuild,
  setLifecycleVersionBuild,
} from './utils/lifecycleStorage';
import {
  LifecycleEmitter,
  type DeepLinkInfo,
  UNKNOWN_PREVIOUS,
} from './lifecycle/lifecycleEvents';
import CircuitBreaker from './utils/circuitBreaker';
import Dispatcher from './dispatcher';
import { PersistentEventQueue } from './persistence/PersistentEventQueue';
import {
  NetworkMonitor,
  type NetworkReachability,
  type NetworkStatus,
} from './utils/networkMonitor';
import { DebouncedNetworkMonitor } from './utils/debouncedNetworkMonitor';
import {
  DEFAULT_MAX_DISK_EVENTS,
  describeConfigError,
  validateInitOptions,
} from './utils/initOptions';

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
  private appContext!: AppContext;
  private appState: AppStateStatus = AppState.currentState;
  private appStateSubscription: { remove?: () => void } | null = null;
  private identityManager: IdentityManager;
  private static readonly AUTO_FLUSH_THRESHOLD = 20;
  // Byte cap is intentionally internal (parity with iOS/Android). Not a
  // public option. 5MB — revisit only if a customer actually needs to tune.
  private static readonly MAX_QUEUE_BYTES = 5 * 1024 * 1024;
  private maxDiskEvents: number = DEFAULT_MAX_DISK_EVENTS;
  private dispatcher!: Dispatcher;
  private persistentQueue!: PersistentEventQueue;
  private tracingEnabled: boolean = false;
  private networkMonitor: NetworkReachability;
  private networkStatus: NetworkStatus = 'connected';
  private unsubscribeNetwork: (() => void) | null = null;
  // Only constructed when trackLifecycleEvents is true, so every emit site
  // is a null-safe call and a disabled client never builds lifecycle payloads.
  private lifecycleEmitter: LifecycleEmitter | null = null;
  // Opt-in by default. Existing customers upgrading the SDK do not begin
  // emitting lifecycle events without explicitly setting this to true.
  private trackLifecycleEvents: boolean = false;
  // Buffers a URL forwarded through recordOpenedURL() so the next
  // Application Opened can carry it. One-shot — cleared on emit.
  private pendingDeepLink: DeepLinkInfo | null = null;
  // Suppressed cold-launch Application Opened (process woke in background).
  // The next background→active transition emits an Opened with from_background:false.
  private coldLaunchOpenDeferred: boolean = false;
  // Set when the app leaves the foreground for background, cleared on the
  // next return to active. The resume Opened keys on this rather than on the
  // last reported state: a return can pass through `inactive` (a FaceID or
  // passcode prompt on resume), and comparing only the previous state would
  // mistake it for a Control Center blip and drop the Opened.
  private wasBackgrounded: boolean = false;

  /**
   * Initializes the analytics client with the provided options.
   * @param options - The initialization options.
   */
  constructor(
    options: InitOptions,
    deps?: { networkMonitor?: NetworkReachability }
  ) {
    // Same rules as the createAnalyticsClient gate, without logging: the
    // gate already logged this call's warnings, and logging here would print
    // every cleartext/clamp warning twice. Constructed directly (bypassing the
    // gate), invalid options throw on every build type, like Android's direct
    // client entry point — this path has no inert session to fall back to.
    const { options: normalized, configError } = validateInitOptions(options, {
      logWarnings: false,
    });
    if (configError) {
      throw new Error(
        `Invalid InitOptions: ${describeConfigError(configError)}`
      );
    }

    this.ingestionHost = normalized.ingestionHost;
    this.writeKey = normalized.writeKey;
    this.flushIntervalSeconds = Math.max(
      1,
      normalized.flushIntervalSeconds ?? 10
    );
    this.maxDiskEvents = normalized.maxDiskEvents!;
    const maxQueueEvents = normalized.maxQueueEvents!;

    setDebugLogging(options.debug ?? false);
    this.trackLifecycleEvents = options.trackLifecycleEvents ?? false;
    this.identityManager = new IdentityManager();
    // Default: wrap the raw native monitor with the asymmetric debounce
    // (immediate offline, 2s stable-online). If a caller injects their own
    // monitor (e.g. in tests), use it as-is so they control the debounce
    // behavior explicitly.
    this.networkMonitor =
      deps?.networkMonitor ?? new DebouncedNetworkMonitor(new NetworkMonitor());
    this.dispatcher = new Dispatcher({
      maxEventCount: maxQueueEvents,
      maxQueueBytes: MetaRouterAnalyticsClient.MAX_QUEUE_BYTES,
      autoFlushThreshold: MetaRouterAnalyticsClient.AUTO_FLUSH_THRESHOLD,
      maxBatchSize: 100,
      flushIntervalSeconds: this.flushIntervalSeconds,
      baseRetryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      isPersistenceEnabled: () => this.maxDiskEvents > 0,
      isNetworkAvailable: () => this.networkStatus === 'connected',
      endpoint: (path) => this.endpoint(path),
      fetchWithTimeout: (url, init, timeoutMs) =>
        this.fetchWithTimeout(url, init, timeoutMs),
      canSend: () =>
        this.lifecycle === 'ready' && !!this.identityManager.getAnonymousId(),
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
      onCapacityOverflow: (events) =>
        this.persistentQueue.bufferEventsForDisk(events),
      onFlushToDisk: (events) => this.persistentQueue.flushEventsToDisk(events),
      onFlushComplete: () => {
        if (this.networkStatus === 'connected') {
          void this.persistentQueue.drainDiskToNetwork(this.dispatcher);
        }
      },
      onScheduleFlushIn: (ms) => {
        (this as any).scheduleFlushIn(ms, { fromDispatcher: true });
      },
      onFatalConfig: () => {
        this.lifecycle = 'disabled';
      },
    });

    this.queue = this.dispatcher.getQueueRef();
    this.persistentQueue = new PersistentEventQueue(this.dispatcher, {
      maxDiskEvents: this.maxDiskEvents,
    });
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
        // Must be read before identityManager.init(): init() generates and
        // persists an anonymousId on first launch, so checking afterwards
        // would make every fresh install look like an upgrade from a
        // pre-lifecycle build and emit Updated(unknown) instead of Installed.
        const hadIdentityBeforeInit = this.trackLifecycleEvents
          ? await this.hasIdentityState()
          : false;
        await this.identityManager.init();

        // Cheap existence check — memory queue starts empty. Any on-disk
        // events are drained directly to the network below (if online) via
        // drainDiskToNetwork, avoiding a memory spike from rehydrating a
        // potentially-large backlog.
        await this.persistentQueue.checkForPersistedEvents();

        this.startFlushLoop();
        this.setupAppStateListener();

        // Load persisted advertising ID if available
        const persistedAdvertisingId =
          await getIdentityField(ADVERTISING_ID_KEY);

        this.appContext = loadAppContext();
        this.context = await getContextInfo(
          this.appContext,
          persistedAdvertisingId || undefined
        );

        if (this.trackLifecycleEvents) {
          this.lifecycleEmitter = new LifecycleEmitter(
            this.dispatcher,
            (event, properties) =>
              this.buildEnrichedEvent({
                type: 'track',
                event,
                properties,
                timestamp: this.now(),
              }),
            this.appContext
          );
        }

        this.lifecycle = 'ready';

        // Lifecycle: detect install/update + capture deep link, then emit
        // the cold-launch sequence. Runs after `ready` so the events carry
        // the final identity/context, and before the network/disk drain
        // block below so they join the first flush batch.
        await this.runColdLaunchLifecycle(hadIdentityBeforeInit);

        // Set initial network state and subscribe to changes
        this.networkStatus = this.networkMonitor.currentStatus;
        this.unsubscribeNetwork = this.networkMonitor.onStatusChange(
          (status) => {
            const wasOffline = this.networkStatus === 'disconnected';
            this.networkStatus = status;

            log(
              `Network status changed: ${wasOffline ? 'disconnected' : 'connected'} -> ${status}`
            );
            if (wasOffline && status === 'connected') {
              log('Dispatcher resumed — device is online, triggering flush');
              this.dispatcher.resetCircuitBreaker();
              // (1) Memory queue → network (existing path)
              void this.flush();
              // (2) Disk → network directly (no load into memory queue)
              void this.persistentQueue.drainDiskToNetwork(this.dispatcher);
            } else if (status === 'disconnected') {
              log('Dispatcher paused — device is offline');
            }
          }
        );

        log('MetaRouter SDK initialized');

        // If online at launch with on-disk events, drain them to the network.
        // Memory queue starts empty, so there's no cold-start flush to run.
        if (
          this.networkStatus === 'connected' &&
          this.persistentQueue.hasDiskData
        ) {
          void this.persistentQueue.drainDiskToNetwork(this.dispatcher);
        }
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
   * Adds identity, writeKey, context and messageId to a raw event. Shared by
   * enqueue() and the lifecycle emitter so both paths produce identical
   * payloads.
   */
  private buildEnrichedEvent(event: EventPayload): EnrichedEventPayload {
    const eventWithIdentity = this.identityManager.addIdentityInfo(event);
    return enrichEvent(eventWithIdentity, this.writeKey, this.context);
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

    this.dispatcher.enqueue(this.buildEnrichedEvent(event));

    // Check if we should flush to disk based on thresholds
    if (this.persistentQueue.shouldFlushToDisk()) {
      void this.persistentQueue.flushToDisk().catch((err) => {
        warn('Failed to flush queue to disk after threshold:', err);
      });
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
   * Runs the cold-launch lifecycle sequence: detect install vs update vs
   * neither, persist the current version/build, capture any cold-launch
   * deep link, and (when the process is foregrounded) emit Application
   * Opened with from_background=false.
   *
   * No-ops when trackLifecycleEvents is false.
   *
   * @param hadIdentityBeforeInit - Whether identity existed in storage before
   *   IdentityManager.init() ran on this launch (see init()).
   */
  private async runColdLaunchLifecycle(
    hadIdentityBeforeInit: boolean
  ): Promise<void> {
    const emitter = this.lifecycleEmitter;
    if (!emitter) {
      return;
    }

    const { version, build } = this.appContext;

    try {
      const [storedVersion, storedBuild] = await Promise.all([
        getLifecycleVersion(),
        getLifecycleBuild(),
      ]);

      if (storedVersion == null && storedBuild == null) {
        if (hadIdentityBeforeInit) {
          emitter.emitUpdated({
            version: UNKNOWN_PREVIOUS,
            build: UNKNOWN_PREVIOUS,
          });
        } else {
          emitter.emitInstalled();
        }
      } else if (storedVersion !== version || storedBuild !== build) {
        emitter.emitUpdated({
          version: storedVersion ?? UNKNOWN_PREVIOUS,
          build: storedBuild ?? UNKNOWN_PREVIOUS,
        });
      }

      await setLifecycleVersionBuild(version, build);
    } catch (err) {
      warn('Lifecycle install/update detection failed:', err);
    }

    // Cold-launch Opened only fires when the process is in foreground.
    // Background-launched processes (push, headless JS) defer to the next
    // background→active transition.
    if (AppState.currentState === 'active') {
      emitter.emitOpened(false, this.consumePendingDeepLink());
    } else {
      this.coldLaunchOpenDeferred = true;
    }
  }

  /**
   * True if any identity field is present in storage. Used to distinguish a
   * fresh install from an existing user upgrading from a pre-lifecycle SDK
   * build. Best-effort: failures are treated as "no identity state".
   */
  private async hasIdentityState(): Promise<boolean> {
    try {
      const [anon, user, group] = await Promise.all([
        getIdentityField(ANONYMOUS_ID_KEY),
        getIdentityField(USER_ID_KEY),
        getIdentityField(GROUP_ID_KEY),
      ]);
      return !!(anon || user || group);
    } catch {
      return false;
    }
  }

  private consumePendingDeepLink(): DeepLinkInfo | undefined {
    if (!this.pendingDeepLink) return undefined;
    const dl = this.pendingDeepLink;
    this.pendingDeepLink = null;
    return dl;
  }

  /**
   * Handles the app state change event.
   * @param nextState - The new app state.
   */
  private handleAppStateChange = async (nextState: AppStateStatus) => {
    const previousState = this.appState;
    this.appState = nextState;

    const leavingForeground =
      previousState === 'active' &&
      (nextState === 'inactive' || nextState === 'background');
    // Accepts inactive as well as active as the previous state: on iOS, RN
    // always reports active → inactive → background (RCTAppState emits
    // `inactive` on WillResignActive first), so requiring active → background
    // would mean Backgrounded never fires on iOS. Android has no `inactive`
    // and goes straight to background. Other previous states (`unknown` or
    // `extension` while a headless or push-woken process settles) never
    // reached the foreground, so they must not emit a Backgrounded without
    // an Opened before it.
    const enteringBackground =
      nextState === 'background' &&
      (previousState === 'active' || previousState === 'inactive');

    if (leavingForeground || enteringBackground) {
      log('App moved to background');
      // Enqueued synchronously before the flush below so the event is part
      // of the same drain. On iOS the inactive step already flushed, so the
      // background step flushes again just to carry this one event out.
      if (enteringBackground) {
        this.wasBackgrounded = true;
        if (this.lifecycle === 'ready') {
          this.lifecycleEmitter?.emitBackgrounded();
        }
      }
      this.stopFlushLoop();
      this.clearNextTimer();
      try {
        await this.flush();
        await this.persistentQueue.flushToDisk();
        await this.persistentQueue.flushPendingDiskWrites();
      } catch (err) {
        warn('Failed to persist queue while moving to background:', err);
      }
    }
    // Cleared on any arrival in the foreground, ready or not: a
    // background → active cycle completed while init() is in flight is
    // covered by the cold-launch Opened, and must not leave the flag set
    // for the next active → inactive → active blip to report as a resume.
    const returningFromBackground =
      nextState === 'active' && this.wasBackgrounded;
    if (nextState === 'active') {
      this.wasBackgrounded = false;
    }
    if (nextState === 'active' && this.lifecycle === 'ready') {
      log('App moved to foreground');
      // Application Opened semantics:
      //   - return after a background entry (directly or via inactive): emit
      //     with from_background=true
      //   - active→inactive→active (Control Center, FaceID, system alert):
      //     suppressed
      //   - first foreground after a background-launched cold start: emit
      //     with from_background=false (deferred cold-launch Opened)
      if (this.coldLaunchOpenDeferred) {
        this.lifecycleEmitter?.emitOpened(false, this.consumePendingDeepLink());
        this.coldLaunchOpenDeferred = false;
      } else if (returningFromBackground) {
        this.lifecycleEmitter?.emitOpened(true, this.consumePendingDeepLink());
      }
      this.startFlushLoop();
      this.flush();
    }
  };

  /**
   * Forward a URL the host received (e.g. from `Linking.getInitialURL`,
   * `Linking.addEventListener('url', ...)`, a UIScene URL handler, or an
   * Android Intent) so it is attached to the next `Application Opened`
   * event as `url` (and `referring_application` if `sourceApplication`
   * is provided). One-shot — the buffer is cleared on the next Opened
   * emit. Last-write-wins if called multiple times before the next Opened.
   *
   * The SDK never reads `Linking` itself: deep links routinely carry auth
   * tokens and OTPs, and an automatic capture would race the host's own
   * sanitized forward for the same one-slot buffer. Only what the host
   * passes here reaches the event (parity with iOS recordOpenedURL and
   * Android recordOpenedUrl).
   *
   * No-op with an always-on warning when `trackLifecycleEvents` is
   * disabled — silent no-ops are bad DX, hosts wiring this up should know
   * they have the feature flag off.
   */
  recordOpenedURL(url: string, sourceApplication?: string): void {
    // Gated on the option, not the emitter: the emitter is null until init()
    // builds it and again after reset(), and in those windows the
    // "disabled" warning would be wrong.
    if (!this.trackLifecycleEvents) {
      warn(
        'recordOpenedURL called but trackLifecycleEvents is disabled — buffered URL ignored. Set trackLifecycleEvents: true in InitOptions to enable.'
      );
      return;
    }
    if (!url || typeof url !== 'string') {
      warn('recordOpenedURL called with invalid url — ignored');
      return;
    }
    this.pendingDeepLink = sourceApplication
      ? { url, referringApplication: sourceApplication }
      : { url };
  }

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
    this.context = await getContextInfo(this.appContext, advertisingId);
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
    this.context = await getContextInfo(this.appContext);
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
   * Returns the current anonymous ID managed by the JS identity layer.
   * Awaits init() if it is still in-flight. Throws only if the client was
   * never initialized or a reset() races with this call.
   */
  async getAnonymousId(): Promise<string> {
    if (this.initPromise) {
      await this.initPromise;
    }
    const id = this.identityManager.getAnonymousId();
    if (!id) {
      throw new Error(
        'getAnonymousId: no anonymous ID available (client was reset or never initialized)'
      );
    }
    return id;
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
      maxQueueEvents: d.maxQueueEvents,
      maxDiskEvents: this.maxDiskEvents,
      tracingEnabled: this.tracingEnabled,
      hasDiskData: this.persistentQueue.hasDiskData,
      networkStatus: this.networkStatus,
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

    // Stop network monitoring
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    this.networkMonitor.stop();

    // Stop background work
    this.dispatcher.stop();
    this.appStateSubscription?.remove?.();
    this.appStateSubscription = null;
    this.pendingDeepLink = null;
    this.coldLaunchOpenDeferred = false;
    this.wasBackgrounded = false;
    this.lifecycleEmitter = null;

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

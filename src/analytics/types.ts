export type EventType =
  | 'track'
  | 'identify'
  | 'group'
  | 'screen'
  | 'alias'
  | 'page';

export interface EventPayload {
  type: EventType;
  event?: string;
  userId?: string;
  groupId?: string;
  traits?: Record<string, any>;
  properties?: Record<string, any>;
  timestamp?: string;
}

export interface EventWithIdentity extends EventPayload {
  anonymousId: string;
}

export interface EnrichedEventPayload extends EventWithIdentity {
  messageId: string;
  context: EventContext;
  writeKey: string;
}

/**
 * Why `createAnalyticsClient` refused its options. In development builds the
 * call throws instead; in release the SDK stays inert for the session and
 * reports this through `onConfigError` and `getDebugInfo().configError`.
 * `description` is the same text the iOS and Android SDKs give.
 */
export type ConfigError =
  | { type: 'emptyWriteKey'; description: string }
  | { type: 'invalidIngestionHost'; raw: string; description: string };

export interface InitOptions {
  /** Required. Trimmed; empty or whitespace-only is a config error. */
  writeKey: string;
  /**
   * Required. An http(s) URL with a host. Trimmed, and trailing slashes are
   * removed. Cleartext http logs a warning unless the host is loopback.
   */
  ingestionHost: string;
  /** Seconds between automatic flushes (default: 10). Clamped to >= 1. */
  flushIntervalSeconds?: number;
  debug?: boolean;
  /** Max events held in the in-memory queue (default: 2000). Clamped to >= 1. */
  maxQueueEvents?: number;
  /**
   * Max events stored on disk for crash-safety + extended offline periods
   * (default: 10000). Negative values are clamped to 0. When set to 0, disk persistence is
   * disabled and the SDK runs as a pure in-memory pipeline (events are lost
   * on app kill — documented tradeoff).
   */
  maxDiskEvents?: number;
  /**
   * Emit Application Opened/Backgrounded/Installed/Updated events.
   * Defaults to false (opt-in). Matches iOS/Android parity — existing
   * customers upgrading the SDK do not begin emitting lifecycle events
   * until they explicitly set this to true.
   */
  trackLifecycleEvents?: boolean;
  /**
   * Minutes of inactivity after which the next event starts a new session
   * (default: 30). Clamped to >= 1. Session stamping itself is always on.
   */
  sessionTimeoutMinutes?: number;
  /**
   * Emit a `Session Started` track event each time a new session is minted.
   * Defaults to false, so upgrading the SDK never changes an app's event
   * volume.
   */
  fireSessionStarted?: boolean;
  /**
   * Called synchronously by `createAnalyticsClient` when the options are
   * invalid in a release build, after the error is logged. The SDK is inert
   * for the session; a later `createAnalyticsClient` with valid options, or
   * `reset()`, recovers it. Development builds throw from
   * `createAnalyticsClient` instead and never call this. Not called for
   * 401/403/404 responses from the ingestion host.
   */
  onConfigError?: (error: ConfigError) => void;
}

/** The part of a `react-native-webview` ref the bridge uses to send replies. */
export interface WebViewRefLike {
  current: { injectJavaScript: (script: string) => void } | null;
}

/** The part of a `react-native-webview` message event the bridge reads. */
export interface WebViewMessageEventLike {
  nativeEvent: { data: string; url?: string };
}

/**
 * Props returned by `attachWebView`, for a `react-native-webview` `<WebView>`.
 * `onMessage` returns true when it consumed a bridge message and false for any
 * other message, so a host with its own handler chains it:
 * `onMessage={(e) => { if (!bridge.onMessage(e)) myHandler(e); }}`.
 */
export interface WebViewBridgeProps {
  /** Empty when the attach was refused, so joining it with a host script is safe. */
  injectedJavaScriptBeforeContentLoaded: string;
  onMessage: (event: WebViewMessageEventLike) => boolean;
}

export interface AnalyticsInterface {
  track: (event: string, props?: Record<string, any>) => void;
  identify: (userId: string, traits?: Record<string, any>) => void;
  group: (groupId: string, traits?: Record<string, any>) => void;
  screen: (name: string, props?: Record<string, any>) => void;
  page: (name: string, props?: Record<string, any>) => void;
  alias: (newUserId: string) => void;
  /**
   * Forward a URL the host received from `Linking` (or platform-specific
   * URL handlers) so it is attached to the next `Application Opened`
   * event. The SDK does not read `Linking` itself, so only URLs passed
   * here are recorded — sanitize before forwarding. One-shot — buffer is
   * cleared on emit; last-write-wins if called multiple times before the
   * next Opened. Safe to call right after createAnalyticsClient(): a URL
   * forwarded while initialization is running still reaches the
   * cold-launch Opened.
   *
   * No-op with an always-on warning when `trackLifecycleEvents` is disabled.
   */
  recordOpenedURL: (url: string, sourceApplication?: string) => void;
  setAdvertisingId: (advertisingId: string) => Promise<void>;
  clearAdvertisingId: () => Promise<void>;
  setTracing: (enabled: boolean) => void;
  flush: () => Promise<void>;
  reset: () => Promise<void>;
  enableDebugLogging: () => void;
  getDebugInfo: () => Promise<Record<string, any>>;
  getAnonymousId: () => Promise<string>;
  /**
   * The current session id, or null before the first event of the process
   * has been enriched. Sessions are minted by events, not reads, so this never
   * waits for initialization and never extends the session. The same value is
   * stamped on every event at `context.providers.metarouter.sessionID`.
   */
  getSessionId: () => Promise<string | null>;
  /**
   * Bridges a `react-native-webview` WebView: pages on `allowedOrigins` get
   * `window.metarouterBridge.track/page`, and their events are sent through
   * this SDK with the app's identity, device context and session. Spread the
   * returned props onto the `<WebView>` and pass its ref so the page receives
   * acks. Origins must be exact `scheme://host[:port]`; invalid rules are
   * refused with a warning and the returned props do nothing. Safe to call
   * before initialization and on every render.
   */
  attachWebView: (
    webViewRef: WebViewRefLike | null | undefined,
    allowedOrigins: string[]
  ) => WebViewBridgeProps;
}

export interface EventContext {
  app: {
    name: string;
    version: string;
    build: string;
    namespace: string;
  };
  device: {
    manufacturer: string;
    model: string;
    name?: string;
    type: string;
    advertisingId?: string;
  };
  library: {
    name: string;
    version: string;
  };
  os: {
    name: string;
    version: string;
  };
  screen: {
    density: number;
    width: number;
    height: number;
  };
  network?: {
    wifi: boolean;
  };
  locale: string;
  timezone: string;
  /**
   * Per-event provider values keyed by provider name — the mobile counterpart
   * of the web SDK's `context.providers`. Set at enrichment, never cached with
   * the rest of the context, because session values change per event.
   */
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: any; // allow arbitrary context
}

export type Lifecycle =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'resetting'
  | 'disabled';

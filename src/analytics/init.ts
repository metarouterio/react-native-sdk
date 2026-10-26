import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient';
import {
  clearConfigDisabled,
  markConfigDisabled,
  proxyClient,
  setInitializingClient,
  setRealClient,
  setAttachWebViewHandler,
  setResetHandler,
  takePendingOpenedURLs,
} from './proxy/proxyClient';
import type { InitOptions, AnalyticsInterface, ConfigError } from './types';
import { validateInitOptions } from './utils/initOptions';
import { BridgeMessageProcessor } from './webview/bridgeMessageProcessor';
import { attachWebViewBridge } from './webview/webViewBridge';

/*
 * Session choreography. Init, disable and reset work runs strictly FIFO on
 * `workChain`, and the flags below follow one rule (the one the Android SDK
 * settled on after its review): flags are written only when work is queued,
 * synchronously in the public call; state changes only when the queued work
 * runs; running work never writes flags. Writing a flag at execution time lets
 * work queued earlier overwrite a decision made by a later call — e.g. an init
 * finishing after a reset was queued would mark the session started again,
 * and the next createAnalyticsClient would silently return an unbound proxy.
 * The single exception is the rollback after a failed init (see runInit).
 */
let initializationStarted = false;
let sessionRefused = false;
let currentOptions: InitOptions | null = null;

// Bumped on every createAnalyticsClient / reset decision, at enqueue time. A
// queued disable compares it when it runs: if a later call has been made since,
// the refusal is already superseded (read, never written, at execution time).
let decisionCount = 0;

let workChain: Promise<void> = Promise.resolve();
let activeClient: MetaRouterAnalyticsClient | null = null;

/**
 * Whether this is a development build. Injectable so tests can exercise the
 * release path; production reads React Native's `__DEV__`.
 */
export const buildConfig = {
  isDevelopmentBuild: (): boolean =>
    typeof __DEV__ !== 'undefined' && __DEV__ === true,
};

// For fire-and-forget enqueues: the runners catch everything today, but a
// future throw must not surface as an unhandled rejection in the host.
const ignoreFailure = () => {};

function enqueue(work: () => Promise<void>): Promise<void> {
  const run = workChain.then(work);
  // The chain itself must survive a failed step; callers that await the
  // returned promise still see the failure.
  workChain = run.catch(() => {});
  return run;
}

/**
 * The config gate. Development builds fail fast with a throw (a red screen at
 * the call site); release builds log an always-on error, call `onConfigError`
 * synchronously and leave the SDK inert for the session — a misconfigured SDK
 * must never take down the host app. Returns false when the session is refused.
 */
function passesConfigGate(
  options: InitOptions,
  configError: ConfigError | null
): configError is null {
  if (configError === null) return true;
  const { description } = configError;
  if (buildConfig.isDevelopmentBuild()) {
    throw new Error(`Invalid InitOptions: ${description}`);
  }
  console.error(
    `[MetaRouter] MetaRouter disabled for this session — ${description}`
  );
  options.onConfigError?.(configError);
  return false;
}

export function createAnalyticsClient(
  options: InitOptions
): AnalyticsInterface {
  const { options: normalized, configError } = validateInitOptions(options);

  if (!passesConfigGate(options, configError)) {
    // An invalid call disables the whole session, even over a running valid
    // client: keeping the stale client would mask the config error.
    initializationStarted = true;
    sessionRefused = true;
    currentOptions = null;
    const { description } = configError!;
    const decision = ++decisionCount;
    enqueue(() => runDisable(description, decision)).catch(ignoreFailure);
    return proxyClient;
  }

  if (initializationStarted && !sessionRefused) {
    if (
      currentOptions &&
      JSON.stringify(currentOptions) !== JSON.stringify(normalized)
    ) {
      console.warn(
        '[MetaRouter] Config changed but client not reset. Call await client.reset() before reinitializing with new options.'
      );
    }
    return proxyClient;
  }

  // First init, or the one valid call that recovers a refused session. The
  // refusal is lifted now, not when the init runs: calls made right after
  // this one (getAnonymousId above all) must wait for the incoming session
  // instead of resolving against the old verdict.
  initializationStarted = true;
  sessionRefused = false;
  currentOptions = normalized;
  clearConfigDisabled();
  const decision = ++decisionCount;
  enqueue(() => runInit(normalized, decision)).catch(ignoreFailure);
  return proxyClient;
}

async function runInit(options: InitOptions, decision: number): Promise<void> {
  // Unreachable today: every path that queues an init has a disable or reset
  // queued ahead of it, or no bound client at all. Kept so a future path that
  // breaks that invariant leaves the bound client alone instead of orphaning
  // it with its flush loop still running.
  if (activeClient) return;
  clearConfigDisabled();

  let instance: MetaRouterAnalyticsClient;
  try {
    instance = new MetaRouterAnalyticsClient(options);
    for (const args of takePendingOpenedURLs()) {
      instance.recordOpenedURL(...args);
    }
    setInitializingClient(instance);
    await instance.init();
  } catch (err) {
    console.error('[MetaRouter] Initialization failed:', err);
    // The one execution-time flag write: restores retryability so the next
    // createAnalyticsClient can try again. Skipped when a later call was made
    // after this init was queued — that call's decision (a reset, another
    // init, a refusal) is newer and must not be overwritten.
    if (decision === decisionCount) {
      initializationStarted = false;
      currentOptions = null;
    }
    return;
  } finally {
    setInitializingClient(null);
  }

  activeClient = instance;
  setRealClient(bindClient(instance));
}

async function runDisable(
  description: string,
  decision: number
): Promise<void> {
  const previous = activeClient;
  activeClient = null;
  // Reset rather than drop the old client: dropped live, its dispatcher would
  // keep flushing, and a disabled session must not send events.
  await resetQuietly(previous);
  if (decision !== decisionCount) {
    // A valid init (or a reset) was requested after this refusal and is
    // queued behind it. Unbind, but keep pending calls — a getAnonymousId
    // made after that later call must resolve against the incoming session,
    // not against this superseded verdict.
    setRealClient(null);
    return;
  }
  markConfigDisabled(description);
}

async function runReset(decision: number): Promise<void> {
  const previous = activeClient;
  activeClient = null;
  await resetQuietly(previous);
  if (decision !== decisionCount) {
    // A createAnalyticsClient came after this reset and is queued behind it:
    // calls made since belong to that incoming session, so they wait for its
    // bind instead of being dropped (or, for promises, rejected) here.
    setRealClient(null);
    return;
  }
  setRealClient(null, { dropPending: true });
}

/**
 * Resets a client being torn down. A failure (e.g. a storage error while
 * deleting the snapshot) is logged, not thrown: the unbind or refusal that
 * follows must still happen, or the proxy stays bound to a half-reset client.
 */
async function resetQuietly(
  client: MetaRouterAnalyticsClient | null
): Promise<void> {
  if (!client) return;
  try {
    await client.reset();
  } catch (err) {
    console.error('[MetaRouter] Reset of the previous client failed:', err);
  }
}

/**
 * `reset()` from the public API, in any state: flags clear now, the teardown
 * runs in order behind anything already queued. A createAnalyticsClient issued
 * right after (even without awaiting) queues a real init behind it.
 */
function resetSession(): Promise<void> {
  if (!initializationStarted) return Promise.resolve();
  initializationStarted = false;
  sessionRefused = false;
  currentOptions = null;
  const decision = ++decisionCount;
  return enqueue(() => runReset(decision));
}

setResetHandler(resetSession);

// One processor for every WebView the host attaches, across sessions — like
// the native proxy's. The sink resolves the client per message: the props are
// handed out at the first render, long before a client binds, and must keep
// working across reset() and re-init. Before a bind, or during a teardown,
// messages are refused with not_ready.
const bridgeProcessor = new BridgeMessageProcessor(
  (envelope) => activeClient?.enqueueBridgeEvent(envelope) ?? false
);

const attachWebView: AnalyticsInterface['attachWebView'] = (
  webViewRef,
  allowedOrigins
) => attachWebViewBridge(webViewRef, allowedOrigins, bridgeProcessor);

// The proxy routes every attachWebView here, bound or not.
setAttachWebViewHandler(attachWebView);

function bindClient(instance: MetaRouterAnalyticsClient): AnalyticsInterface {
  return {
    track: (event, props) => instance.track(event, props),
    identify: (userId, traits) => instance.identify(userId, traits),
    group: (groupId, traits) => instance.group(groupId, traits),
    screen: (name, props) => instance.screen(name, props),
    page: (name, props) => instance.page(name, props),
    alias: (newUserId) => instance.alias(newUserId),
    recordOpenedURL: (url, sourceApplication) =>
      instance.recordOpenedURL(url, sourceApplication),
    setAdvertisingId: (advertisingId) =>
      instance.setAdvertisingId(advertisingId),
    clearAdvertisingId: () => instance.clearAdvertisingId(),
    setTracing: (enabled) => instance.setTracing(enabled),
    enableDebugLogging: () => instance.enableDebugLogging(),
    getDebugInfo: () => instance.getDebugInfo(),
    getAnonymousId: () => instance.getAnonymousId(),
    getSessionId: () => instance.getSessionId(),
    attachWebView,
    flush: () => instance.flush(),
    reset: () => resetSession(),
  };
}

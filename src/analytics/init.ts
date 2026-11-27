import { buildConfig } from './utils/buildConfig';
import { getProcessProviderContextManager } from './providers/providerContextManager';
import { getProcessConsentManager } from './consent/consentManager';
import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient';
import {
  clearConfigDisabled,
  markConfigDisabled,
  proxyClient,
  setInitializingClient,
  setRealClient,
  setAttachWebViewHandler,
  setResetHandler,
  setSetAnonymousIdHandler,
  dropCallsQueuedBeforeReset,
  takePendingOpenedURLs,
} from './proxy/proxyClient';
import type { InitOptions, AnalyticsInterface, ConfigError } from './types';
import { validateInitOptions } from './utils/initOptions';
import { BridgeMessageProcessor } from './webview/bridgeMessageProcessor';
import { attachWebViewBridge } from './webview/webViewBridge';
import { error as logError, warn } from './utils/logger';
import { validateHostAnonymousId } from './IdentityManager';
import {
  clearIdentityStorage,
  currentIdentityEpoch,
  writeHostAnonymousId,
} from './utils/identityStorage';

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

// The client a setAnonymousId also reaches in memory: the session's client
// from the moment its init starts until a reset or refusal is called
// (synchronously, like the flags above). Storage always gets the id; a client
// built later reads it from there.
let identityOwner: MetaRouterAnalyticsClient | null = null;

// Re-exported: tests flip the release path through init.buildConfig.
export { buildConfig };

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
  logError(`MetaRouter disabled for this session — ${description}`);
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
    if (initializationStarted && !sessionRefused) {
      // Discarding a running session clears its identity, as the Android SDK
      // does (its disable resets the client); in call order with identity
      // writes, like reset(). Its queued calls are dropped like a reset's: a
      // valid call that recovers the session must not replay them.
      void clearIdentityStorage();
      dropCallsQueuedBeforeReset({ degrade: true });
    }
    identityOwner = null;
    setInitializingClient(null);
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
      warn(
        'Config changed but client not reset. Call await client.reset() before reinitializing with new options.'
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
  // Captured now, not when the init runs: a reset() or refusal called before
  // it runs must still drop this client's identity writes.
  const identityEpoch = currentIdentityEpoch();
  enqueue(() => runInit(normalized, decision, identityEpoch)).catch(
    ignoreFailure
  );
  return proxyClient;
}

async function runInit(
  options: InitOptions,
  decision: number,
  identityEpoch: number
): Promise<void> {
  // Unreachable today: every path that queues an init has a disable or reset
  // queued ahead of it, or no bound client at all. Kept so a future path that
  // breaks that invariant leaves the bound client alone instead of orphaning
  // it with its flush loop still running.
  if (activeClient) return;
  // Superseded before it ran: a reset() or refusal called after this init was
  // queued tears its session down anyway, so building a client would only emit
  // its cold-launch events and answer calls meant for the next session (the
  // native SDKs skip the build too). Calls made meanwhile wait for the next
  // bind; queued opened URLs stay for the next init.
  if (decision !== decisionCount) return;
  clearConfigDisabled();

  let instance: MetaRouterAnalyticsClient;
  try {
    instance = new MetaRouterAnalyticsClient(options, { identityEpoch });
    identityOwner = instance;
    for (const args of takePendingOpenedURLs()) {
      instance.recordOpenedURL(...args);
    }
    setInitializingClient(instance);
    await instance.init();
  } catch (err) {
    logError('Initialization failed:', err);
    if (identityOwner === instance!) identityOwner = null;
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

  if (decision !== decisionCount) {
    // A reset() or refusal arrived while init() ran. Not bound, so the
    // teardown queued behind this init finds no active client: stop this one
    // here, or its flush loop would keep running.
    await resetQuietly(instance);
    return;
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
    logError('Reset of the previous client failed:', err);
  }
}

/**
 * `reset()` from the public API, in any state: flags clear now, the teardown
 * runs in order behind anything already queued. A createAnalyticsClient issued
 * right after (even without awaiting) queues a real init behind it.
 */
function resetSession(): Promise<void> {
  // Identity storage is cleared now, in call order with identity writes and
  // whether or not a client is running: a host id set before this reset is
  // discarded, one set after it is kept for the next client. Writes from the
  // client being torn down are dropped from here on.
  identityOwner = null;
  void clearIdentityStorage();
  // Calls queued before this reset are dropped now: the init they waited for
  // may be skipped or torn down, and a later init must not replay them. A
  // client still initializing no longer receives opened URLs either; they
  // queue for the next init.
  dropCallsQueuedBeforeReset();
  setInitializingClient(null);
  if (!initializationStarted) return Promise.resolve();
  initializationStarted = false;
  sessionRefused = false;
  currentOptions = null;
  const decision = ++decisionCount;
  return enqueue(() => runReset(decision));
}

setResetHandler(resetSession);

/**
 * setAnonymousId from the public API, in any state; never queued. See
 * AnalyticsInterface.setAnonymousId.
 */
function setAnonymousId(anonymousId: string): boolean {
  const id = validateHostAnonymousId(
    anonymousId,
    identityOwner?.peekAnonymousId() ?? null
  );
  if (id === null) return false;
  // Stored at call time, like the native SDKs: a client built later (or the
  // next launch, if the app dies first) reads it from storage.
  void writeHostAnonymousId(id);
  identityOwner?.adoptHostAnonymousId(id);
  return true;
}

setSetAnonymousIdHandler(setAnonymousId);

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

// Loads the stored provider context as soon as the SDK loads — synchronously
// from native storage, so a getProviderContext() before createAnalyticsClient
// already sees last launch's values (later without the native module).
getProcessProviderContextManager();
getProcessConsentManager();

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
    setAnonymousId,
    getSessionId: () => instance.getSessionId(),
    attachWebView,
    setProviderContext: (provider, key, value) =>
      instance.setProviderContext(provider, key, value),
    getProviderContext: () => instance.getProviderContext(),
    clearProviderContext: (provider) => instance.clearProviderContext(provider),
    clearAllProviderContext: () => instance.clearAllProviderContext(),
    registerConsentCategories: (categories) =>
      instance.registerConsentCategories(categories),
    setConsent: (consent) => instance.setConsent(consent),
    getConsent: () => instance.getConsent(),
    clearConsent: () => instance.clearConsent(),
    subscribeToConsent: (handler) => instance.subscribeToConsent(handler),
    flush: () => instance.flush(),
    reset: () => resetSession(),
  };
}

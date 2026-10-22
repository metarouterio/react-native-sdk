import type { AnalyticsInterface } from '../types';

type PendingItem = {
  fn: () => void | Promise<void>;
  reject?: (err: Error) => void; // only for async calls
  // Settles an async call's promise with its degraded value when the session
  // is refused before the call could run (see markConfigDisabled).
  degrade?: () => void;
  // Arguments of a queued recordOpenedURL, so the init that builds the next
  // client can hand them over before its cold-launch Opened (see
  // takePendingOpenedURLs).
  openedURL?: Parameters<AnalyticsInterface['recordOpenedURL']>;
};

const pendingCalls: PendingItem[] = [];
const MAX_PENDING_CALLS = 20;

let realClient: AnalyticsInterface | null = null;

// Description of the config error that refused this session, or null. While
// set, calls still queue (and replay if a valid init recovers the session),
// but nothing that returns a promise may wait for a bind that is not coming.
let configDisabledError: string | null = null;

// Owned by init.ts: reset must work before a bind (it is how a refused or
// still-initializing session is cleared), so the proxy cannot route it to the
// bound client alone.
let resetHandler: (() => Promise<void>) | null = null;

// The client whose init() is still running. recordOpenedURL only fills a
// one-slot buffer that the cold-launch Application Opened reads during
// init(), and the proxy binds only after init() resolves — so a cold-launch
// URL queued for replay would always miss its own Opened and ride on the
// next resume instead. Routing it here lets it land before that emit.
let initializingClient: Pick<AnalyticsInterface, 'recordOpenedURL'> | null =
  null;

// Async-returning methods
type AsyncMethod =
  | 'flush'
  | 'getDebugInfo'
  | 'getAnonymousId'
  | 'setAdvertisingId'
  | 'clearAdvertisingId';
const ASYNC_METHODS: Record<AsyncMethod, true> = {
  flush: true,
  getDebugInfo: true,
  getAnonymousId: true,
  setAdvertisingId: true,
  clearAdvertisingId: true,
};
const isAsyncMethod = (m: PropertyKey): m is AsyncMethod =>
  (ASYNC_METHODS as any)[m] === true;

/**
 * What an async call resolves to on a config-refused session. getAnonymousId
 * resolves "" promptly, like iOS and Android: a permanent hang on a
 * misconfigured SDK would be worse than the crash this contract replaces.
 */
function degradedResult(methodName: AsyncMethod): unknown {
  switch (methodName) {
    case 'getAnonymousId':
      return '';
    case 'getDebugInfo':
      return {
        lifecycle: 'disabled',
        proxy: true,
        pendingCalls: pendingCalls.length,
        configError: configDisabledError,
      };
    default:
      return undefined;
  }
}

// One in-flight flush at a time
let flushInFlight: Promise<void> | null = null;

/**
 * Dispatches a method call to the underlying analytics client, handling both
 * pre-bind (proxy) and post-bind (real client) states.
 *
 * - **Post-bind:**
 *   Calls the method directly on the bound `realClient`.
 *   - For `flush()`, enforces a singleflight: concurrent calls return the same
 *     in-flight Promise and no duplicate flush is triggered.
 *
 * - **Pre-bind:**
 *   - Queues the call in `pendingCalls` for replay after binding.
 *   - For async methods (`flush`, `getDebugInfo`, `setAdvertisingId`, `clearAdvertisingId`),
 *     returns a Promise that resolves/rejects after replay. Keeps a `reject` handle so
 *     `dropPending` can fail them immediately.
 *   - For sync "fire-and-forget" methods, returns `void` immediately.
 *   - For `reset`, returns an immediate resolved Promise (no-op).
 *   - If the queue exceeds `MAX_PENDING_CALLS`, drops the oldest call
 *     (rejecting it if async) and logs a warning.
 *
 * @param methodName - Name of the `AnalyticsInterface` method to invoke.
 * @param args - Arguments to pass to the method.
 * @returns The method's return value or a queued Promise, depending on binding state.
 */
function handleMethodCall<T extends keyof AnalyticsInterface>(
  methodName: T,
  ...args: Parameters<AnalyticsInterface[T]>
): ReturnType<AnalyticsInterface[T]> {
  // Real client bound
  if (realClient && methodName !== 'reset') {
    if (methodName === 'flush') {
      if (flushInFlight)
        return flushInFlight as ReturnType<AnalyticsInterface[T]>;
      const p = Promise.resolve((realClient.flush as any)(...args)).then(
        () => undefined
      );
      flushInFlight = p.finally(() => {
        flushInFlight = null;
      });
      return flushInFlight as ReturnType<AnalyticsInterface[T]>;
    }
    return (realClient[methodName] as any)(...args);
  }

  if (methodName === 'reset') {
    if (resetHandler) {
      return resetHandler() as ReturnType<AnalyticsInterface[T]>;
    }
    return (realClient ? realClient.reset() : Promise.resolve()) as ReturnType<
      AnalyticsInterface[T]
    >;
  }

  // No real client bound yet
  if (methodName === 'recordOpenedURL' && initializingClient) {
    initializingClient.recordOpenedURL(
      ...(args as Parameters<AnalyticsInterface['recordOpenedURL']>)
    );
    return undefined as ReturnType<AnalyticsInterface[T]>;
  }

  // Refused session: queries answer now and never take a queue slot.
  if (
    configDisabledError !== null &&
    (methodName === 'getAnonymousId' || methodName === 'getDebugInfo')
  ) {
    return Promise.resolve(degradedResult(methodName)) as ReturnType<
      AnalyticsInterface[T]
    >;
  }

  if (pendingCalls.length >= MAX_PENDING_CALLS) {
    const dropped = pendingCalls.shift();
    dropped?.reject?.(
      new Error(
        `[MetaRouter] Dropped oldest call (queue cap ${MAX_PENDING_CALLS})`
      )
    );
    console.warn(
      `[MetaRouter] Oldest call dropped (queue cap ${MAX_PENDING_CALLS})`
    );
  }

  if (isAsyncMethod(methodName) && configDisabledError !== null) {
    // Refused session: commands (flush, advertising id) still queue so a
    // recovering valid init replays them like any other call, but their
    // promise resolves now instead of waiting for a bind.
    pendingCalls.push({
      fn: () => {
        if (!realClient) return;
        return Promise.resolve((realClient[methodName] as any)(...args)).then(
          () => undefined
        );
      },
    });
    return Promise.resolve(undefined) as ReturnType<AnalyticsInterface[T]>;
  }

  if (isAsyncMethod(methodName)) {
    // Queue async call and return a promise that resolves after bind+run
    return new Promise<any>((resolve, reject) => {
      pendingCalls.push({
        reject, // keep a handle for dropPending
        degrade: () => resolve(degradedResult(methodName)),
        fn: async () => {
          try {
            if (!realClient) {
              return reject(
                new Error('Proxy detached before real client was bound')
              );
            }

            if (methodName === 'flush') {
              if (!flushInFlight) {
                const p = Promise.resolve(
                  (realClient.flush as any)(...args)
                ).then(() => undefined);
                flushInFlight = p.finally(() => {
                  flushInFlight = null;
                });
              }
              return flushInFlight!.then(resolve, reject);
            }

            const result = (realClient[methodName] as any)(...args);
            Promise.resolve(result).then(resolve, reject);
          } catch (err) {
            reject(err as Error);
          }
        },
      });
    }) as ReturnType<AnalyticsInterface[T]>;
  }

  // Fire-and-forget: queue and return void
  pendingCalls.push({
    fn: () => {
      if (!realClient) return;
      (realClient[methodName] as any)(...args);
    },
    ...(methodName === 'recordOpenedURL' && {
      openedURL: args as Parameters<AnalyticsInterface['recordOpenedURL']>,
    }),
  });
  return undefined as ReturnType<AnalyticsInterface[T]>;
}

export const proxyClient: AnalyticsInterface = {
  track: (event, props) => handleMethodCall('track', event, props),
  identify: (userId, traits) => handleMethodCall('identify', userId, traits),
  group: (groupId, traits) => handleMethodCall('group', groupId, traits),
  screen: (name, props) => handleMethodCall('screen', name, props),
  page: (name, props) => handleMethodCall('page', name, props),
  alias: (newUserId) => handleMethodCall('alias', newUserId),
  recordOpenedURL: (url, sourceApplication) =>
    handleMethodCall('recordOpenedURL', url, sourceApplication),
  setAdvertisingId: (advertisingId) =>
    handleMethodCall('setAdvertisingId', advertisingId) as Promise<void>,
  clearAdvertisingId: () =>
    handleMethodCall('clearAdvertisingId') as Promise<void>,
  setTracing: (enabled) => handleMethodCall('setTracing', enabled),

  flush: () => handleMethodCall('flush'),
  reset: () => handleMethodCall('reset'),
  enableDebugLogging: () => handleMethodCall('enableDebugLogging'),
  getDebugInfo: () => handleMethodCall('getDebugInfo'),
  getAnonymousId: () => handleMethodCall('getAnonymousId'),
};

/**
 * Sets (or clears, with `null`) the client whose init() is in flight, so
 * recordOpenedURL reaches it before the cold-launch Opened is emitted.
 * Cleared as soon as init() settles, before binding.
 */
export function setInitializingClient(
  client: Pick<AnalyticsInterface, 'recordOpenedURL'> | null
) {
  initializingClient = client;
}

/**
 * Binds or unbinds the real analytics client to the proxy and manages queued calls.
 *
 * - **Binding (`client` is non-null):**
 *   - Sets `realClient` to `client`.
 *   - Drains `pendingCalls` FIFO and replays each thunk against the bound client.
 *     Replay errors are swallowed (logged) to avoid crashing callers that already returned.
 *     If a thunk returns a Promise, its rejection is caught to prevent unhandled rejections.
 *
 * - **Unbinding (`client` is null):**
 *   - If `opts.dropPending` is true:
 *     - Rejects any queued async calls using their stored `reject` handlers
 *       with an explanatory error.
 *     - Empties the `pendingCalls` queue.
 *   - Resets `flushInFlight` so subsequent `flush()` calls can start a new singleflight.
 *
 * **Notes:**
 * - Replay is non-reentrant for the current batch: thunks enqueued during replay
 *   are not executed until a future bind/drain cycle (prevents infinite loops).
 * - This function does not start initialization; callers are expected to call
 *   `setRealClient(real)` once the real client is ready, and `setRealClient(null, { dropPending: true })`
 *   on reset/teardown to ensure pre-bind Promises don’t hang indefinitely.
 *
 * @param client - The concrete analytics client to bind, or `null` to unbind.
 * @param opts - Options for unbinding behavior.
 * @param opts.dropPending - When unbinding, reject and clear any queued pre-bind async calls.
 */
export function setRealClient(
  client: AnalyticsInterface | null,
  opts?: { dropPending?: boolean }
) {
  realClient = client;
  // Binding a client, or a reset's unbind, ends any refusal.
  configDisabledError = null;

  if (client) {
    const items = pendingCalls.splice(0, pendingCalls.length);
    for (const { fn } of items) {
      try {
        Promise.resolve(fn()).catch(() => {});
      } catch (err) {
        console.warn('[MetaRouter] replay error:', err);
      }
    }
  } else {
    if (opts?.dropPending) {
      for (const it of pendingCalls)
        it.reject?.(new Error('[MetaRouter] Proxy dropped before bind'));
      pendingCalls.length = 0;
    }
    flushInFlight = null; // reset coalescer
  }
}

/** Registers init.ts's session reset, used by `reset()` in every state. */
export function setResetHandler(handler: (() => Promise<void>) | null) {
  resetHandler = handler;
}

/**
 * Refuses the session: unbinds, drops calls queued before the refusal (they
 * belonged to a session that never bound), settles their promises with the
 * degraded value instead of rejecting, and makes later async calls resolve
 * degraded. Calls made after this point queue and replay on recovery.
 */
export function markConfigDisabled(description: string) {
  realClient = null;
  flushInFlight = null;
  configDisabledError = description;
  const items = pendingCalls.splice(0, pendingCalls.length);
  for (const it of items) it.degrade?.();
}

/**
 * Lifts a refusal before a valid init builds its client, so async calls made
 * during that init wait for the incoming bind rather than resolving against
 * the previous verdict.
 */
export function clearConfigDisabled() {
  configDisabledError = null;
}

/**
 * Removes and returns queued recordOpenedURL calls, oldest first. The init that
 * builds a client applies them before init() runs: createAnalyticsClient only
 * queues that init, so a URL forwarded right after the call (the usual
 * `Linking.getInitialURL()` wiring) is queued here before any client exists,
 * and replaying it after bind would miss the cold-launch Opened.
 */
export function takePendingOpenedURLs(): Parameters<
  AnalyticsInterface['recordOpenedURL']
>[] {
  const taken: Parameters<AnalyticsInterface['recordOpenedURL']>[] = [];
  for (let i = 0; i < pendingCalls.length; ) {
    const args = pendingCalls[i]!.openedURL;
    if (args) {
      taken.push(args);
      pendingCalls.splice(i, 1);
    } else {
      i++;
    }
  }
  return taken;
}

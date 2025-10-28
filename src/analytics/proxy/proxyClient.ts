import type { AnalyticsInterface } from "../types";

type PendingItem = {
  fn: () => void | Promise<void>;
  reject?: (err: Error) => void; // only for async calls
};

const pendingCalls: PendingItem[] = [];
const MAX_PENDING_CALLS = 20;

let realClient: AnalyticsInterface | null = null;

// Async-returning methods
type AsyncMethod = "flush" | "getDebugInfo" | "setAdvertisingId" | "clearAdvertisingId";
const ASYNC_METHODS: Record<AsyncMethod, true> = {
  flush: true,
  getDebugInfo: true,
  setAdvertisingId: true,
  clearAdvertisingId: true,
};
const isAsyncMethod = (m: PropertyKey): m is AsyncMethod =>
  (ASYNC_METHODS as any)[m] === true;

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
 *   - For async methods (`flush`, `reset`, `getDebugInfo`), returns a Promise
 *     that resolves/rejects after replay. Keeps a `reject` handle so
 *     `dropPending` can fail them immediately.
 *   - For sync "fire-and-forget" methods, returns `void` immediately.
 *   - For `getDebugInfo`, returns an immediate proxy snapshot without queuing.
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
  if (realClient) {
    if (methodName === "flush") {
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

  // No real client bound yet
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

  // Special-cases while unbound:
  if (methodName === "getDebugInfo") {
    // Return immediate proxy snapshot instead of queueing
    return Promise.resolve({
      proxy: true,
      pendingCalls: pendingCalls.length,
    }) as ReturnType<AnalyticsInterface[T]>;
  }

  if (methodName === "reset") {
    // Nothing to reset pre-bind; resolve immediately
    return Promise.resolve() as ReturnType<AnalyticsInterface[T]>;
  }

  if (isAsyncMethod(methodName)) {
    // Queue async call and return a promise that resolves after bind+run
    return new Promise<any>((resolve, reject) => {
      pendingCalls.push({
        reject, // keep a handle for dropPending
        fn: async () => {
          try {
            if (!realClient) {
              return reject(
                new Error("Proxy detached before real client was bound")
              );
            }

            if (methodName === "flush") {
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
  });
  return undefined as ReturnType<AnalyticsInterface[T]>;
}

export const proxyClient: AnalyticsInterface = {
  track: (event, props) => handleMethodCall("track", event, props),
  identify: (userId, traits) => handleMethodCall("identify", userId, traits),
  group: (groupId, traits) => handleMethodCall("group", groupId, traits),
  screen: (name, props) => handleMethodCall("screen", name, props),
  page: (name, props) => handleMethodCall("page", name, props),
  alias: (newUserId) => handleMethodCall("alias", newUserId),
  setAdvertisingId: (advertisingId) => handleMethodCall("setAdvertisingId", advertisingId) as Promise<void>,
  clearAdvertisingId: () => handleMethodCall("clearAdvertisingId") as Promise<void>,
  setTracing: (enabled) => handleMethodCall("setTracing", enabled),

  flush: () => handleMethodCall("flush"),
  reset: () => handleMethodCall("reset"),
  enableDebugLogging: () => handleMethodCall("enableDebugLogging"),
  getDebugInfo: () => handleMethodCall("getDebugInfo"),
};

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

  if (client) {
    const items = pendingCalls.splice(0, pendingCalls.length);
    for (const { fn } of items) {
      try {
        Promise.resolve(fn()).catch(() => {});
      } catch (err) {
        console.warn("[MetaRouter] replay error:", err);
      }
    }
  } else {
    if (opts?.dropPending) {
      for (const it of pendingCalls)
        it.reject?.(new Error("[MetaRouter] Proxy dropped before bind"));
      pendingCalls.length = 0;
    }
    flushInFlight = null; // reset coalescer
  }
}

import type { AnalyticsInterface } from "../types";

type PendingFn = () => void | Promise<void>;
const pendingCalls: PendingFn[] = [];
const MAX_PENDING_CALLS = 20;

let realClient: AnalyticsInterface | null = null;

// Async-returning methods
const ASYNC_METHODS: Record<string, true> = {
  flush: true,
  reset: true,
  getDebugInfo: true,
};

// One in-flight flush at a time
let flushInFlight: Promise<void> | null = null;

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
    pendingCalls.shift();
    console.warn(
      `[MetaRouter] Proxy queue reached max size (${MAX_PENDING_CALLS}). Oldest call dropped.`
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

  if (ASYNC_METHODS[String(methodName)]) {
    // Queue async call and return a promise that resolves after bind+run
    return new Promise<any>((resolve, reject) => {
      pendingCalls.push(async () => {
        try {
          if (!realClient)
            return reject(
              new Error("Proxy detached before real client was bound")
            );

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
          result instanceof Promise
            ? result.then(resolve, reject)
            : resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    }) as ReturnType<AnalyticsInterface[T]>;
  }

  // Fire-and-forget: queue and return void
  pendingCalls.push(() => {
    if (!realClient) return;
    (realClient[methodName] as any)(...args);
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

  flush: () => handleMethodCall("flush"),
  reset: () => handleMethodCall("reset"),
  enableDebugLogging: () => handleMethodCall("enableDebugLogging"),
  getDebugInfo: () => handleMethodCall("getDebugInfo"),
};

export function setRealClient(
  client: AnalyticsInterface | null,
  opts?: { dropPending?: boolean }
) {
  realClient = client;

  if (client) {
    const fns = pendingCalls.splice(0, pendingCalls.length);
    for (const fn of fns) {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch(() => {});
      } catch {}
    }
  } else {
    if (opts?.dropPending) pendingCalls.length = 0;
    flushInFlight = null; // reset coalescer
  }
}

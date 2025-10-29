import { MetaRouterAnalyticsClient } from "./MetaRouterAnalyticsClient";
import { proxyClient, setRealClient } from "./proxy/proxyClient";
import type { InitOptions, AnalyticsInterface } from "./types";

// Only one initialization in flight
let initPromise: Promise<void> | null = null;
let currentOptions: InitOptions | null = null;

export function createAnalyticsClient(
  options: InitOptions
): AnalyticsInterface {
  // Check if options have changed - if so, force reset first
  const optionsChanged = currentOptions &&
    JSON.stringify(currentOptions) !== JSON.stringify(options);

  if (optionsChanged && initPromise) {
    console.warn(
      '[MetaRouter] Config changed but client not reset. Call await client.reset() before reinitializing with new options.'
    );
  }

  if (!initPromise) {
    currentOptions = options;
    initPromise = (async () => {
      const instance = new MetaRouterAnalyticsClient(options);
      await instance.init();
      const boundClient: AnalyticsInterface = {
        track: (event, props) => instance.track(event, props),
        identify: (userId, traits) => instance.identify(userId, traits),
        group: (groupId, traits) => instance.group(groupId, traits),
        screen: (name, props) => instance.screen(name, props),
        page: (name, props) => instance.page(name, props),
        alias: (newUserId) => instance.alias(newUserId),
        setAdvertisingId: (advertisingId) => instance.setAdvertisingId(advertisingId),
        clearAdvertisingId: () => instance.clearAdvertisingId(),
        setTracing: (enabled) => instance.setTracing(enabled),
        enableDebugLogging: () => instance.enableDebugLogging(),
        getDebugInfo: () => instance.getDebugInfo(),
        flush: () => instance.flush(),
        reset: async () => {
          await instance.reset();
          setRealClient(null, { dropPending: true });
          initPromise = null;
          currentOptions = null;
        },
      };
      setRealClient(boundClient);
    })();
  }
  return proxyClient;
}

import { MetaRouterAnalyticsClient } from "./MetaRouterAnalyticsClient";
import { proxyClient, setRealClient } from "./proxy/proxyClient";
import type { InitOptions, AnalyticsInterface } from "./types";

// Only one initialization in flight
let initPromise: Promise<void> | null = null;

export function createAnalyticsClient(
  options: InitOptions
): AnalyticsInterface {
  if (!initPromise) {
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
        enableDebugLogging: () => instance.enableDebugLogging(),
        getDebugInfo: () => instance.getDebugInfo(),
        flush: () => instance.flush(),
        reset: async () => {
          await instance.reset();
          setRealClient(null, { dropPending: true });
          initPromise = null;
        },
      };
      setRealClient(boundClient);
    })();
  }
  return proxyClient;
}

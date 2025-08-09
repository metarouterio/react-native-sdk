import { MetaRouterAnalyticsClient } from "./MetaRouterAnalyticsClient";
import { proxyClient, setRealClient } from "./proxy/proxyClient";
import type { InitOptions, AnalyticsInterface } from "./types";

// Single-flight guard so concurrent callers don't double-init
let inFlight: Promise<AnalyticsInterface> | null = null;

export async function createAnalyticsClient(
  options: InitOptions
): Promise<AnalyticsInterface> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // 1) Build the real client and fully initialize it
    const instance = new MetaRouterAnalyticsClient(options);
    await instance.init();

    // 2) Wrap the real instance with the public interface
    //    Note: reset() also detaches the proxy so you’re "off" until you call createAnalyticsClient() again.
    const boundClient: AnalyticsInterface = {
      track: (event, props) => instance.track(event, props),
      identify: (userId, traits) => instance.identify(userId, traits),
      group: (groupId, traits) => instance.group(groupId, traits),
      screen: (name, props) => instance.screen(name, props),
      page: (name, props) => instance.page(name, props),
      alias: (newUserId) => instance.alias(newUserId),
      enableDebugLogging: () => instance.enableDebugLogging(),
      getDebugInfo: () => instance.getDebugInfo(),
      flush: () => instance.flush(),

      // Detach the proxy after a successful reset so nothing leaks out
      reset: async () => {
        await instance.reset();
        setRealClient(null, { dropPending: true }); // proxy goes idle; calls will queue or no-op
      },
    };

    // 3) Bind the proxy to this fully-initialized client
    setRealClient(boundClient);

    // 4) Return the proxy as the single public handle
    return proxyClient;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

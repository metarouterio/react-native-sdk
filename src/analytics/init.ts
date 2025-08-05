import { MetaRouterAnalyticsClient } from "./MetaRouterAnalyticsClient";
import { proxyClient, setRealClient } from "./proxy/proxyClient";
import type { InitOptions, AnalyticsInterface } from "./types";

// Tracks whether a client has already been bound to the proxy
let proxyBound = false;

/**
 * Modular factory for creating an independent analytics client.
 * Binds the first created client to the proxy for queued events.
 * @param options Initialization options.
 * @returns A fully initialized analytics interface.
 */
export async function createAnalyticsClient(
  options: InitOptions
): Promise<AnalyticsInterface> {
  const instance = new MetaRouterAnalyticsClient(options);
  await instance.waitForInitialization();

  const analyticsInterface: AnalyticsInterface = {
    track: (event, props) => instance.track(event, props),
    identify: (userId, traits) => instance.identify(userId, traits),
    group: (groupId, traits) => instance.group(groupId, traits),
    screen: (name, props) => instance.screen(name, props),
    page: (name, props) => instance.page(name, props),
    alias: (newUserId) => instance.alias(newUserId),
    flush: () => instance.flush(),
    reset: () => instance.reset(),
    enableDebugLogging: () => instance.enableDebugLogging(),
    getDebugInfo: () => instance.getDebugInfo(),
  };

  // Forward proxy calls to this instance (only once)
  if (!proxyBound) {
    setRealClient(analyticsInterface);
    proxyBound = true;
  }

  return analyticsInterface;
}

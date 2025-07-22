import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient';
import { proxyClient, setRealClient } from './proxy/proxyClient';
import type { InitOptions, AnalyticsInterface } from './types';

let initialized = false;
let client: MetaRouterAnalyticsClient | null = null;
let analyticsInterface: AnalyticsInterface | null = null;

export async function initAnalytics(options: InitOptions): Promise<AnalyticsInterface> {
  if (initialized) return analyticsInterface!;

  client = new MetaRouterAnalyticsClient(options);
  
  // Wait for the client to fully initialize (including anonymous ID loading)
  await client.waitForInitialization();
  
  analyticsInterface = {
    track: (event, props) => client!.track(event, props),
    identify: (userId, traits) => client!.identify(userId, traits),
    group: (groupId, traits) => client!.group(groupId, traits),
    screen: (name, props) => client!.screen(name, props),
    alias: (newUserId) => client!.alias(newUserId),
    flush: () => client!.flush(),
    cleanup: () => client!.cleanup(),
    enableDebugLogging: () => client!.enableDebugLogging(),
    getDebugInfo: () => client!.getDebugInfo(),
  };

  initialized = true;
  setRealClient(analyticsInterface);
  return analyticsInterface;
}

export function getAnalyticsClient(): AnalyticsInterface {
  return initialized ? analyticsInterface! : proxyClient;
}

export async function resetAnalytics(): Promise<void> {
  await client?.cleanup();
  client = null;
  analyticsInterface = null;
  initialized = false;
  setRealClient(null);
}
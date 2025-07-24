import { MetaRouterAnalyticsClient } from './MetaRouterAnalyticsClient';
import { proxyClient, setRealClient } from './proxy/proxyClient';
import type { InitOptions, AnalyticsInterface } from './types';

let initialized = false;
let client: MetaRouterAnalyticsClient | null = null;
let analyticsClient: AnalyticsInterface | null = null;

/**
 * Initializes the analytics client singleton.
 * Waits for async setup (e.g., identity loading) before returning the interface.
 * Returns the same instance on subsequent calls.
 * @param options Analytics initialization options.
 * @returns The analytics interface.
 */
export async function initAnalytics(options: InitOptions): Promise<AnalyticsInterface> {
  if (initialized) return analyticsClient!;

  client = new MetaRouterAnalyticsClient(options);
  
  // Wait for the client to fully initialize (including anonymous ID loading)
  await client.waitForInitialization();
  
  analyticsClient = {
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
  setRealClient(analyticsClient);
  return analyticsClient;
}

/**
 * Retrieves the analytics client singleton.
 * Returns the proxy client before initialization, and the real client after.
 * @returns The analytics interface.
 */
export function getAnalyticsClient(): AnalyticsInterface {
  return initialized ? analyticsClient! : proxyClient;
}

/**
 * Resets the analytics client singleton.
 * Cleans up the client and sets it to null.
 * @returns A promise that resolves when the client is reset.
 */
export async function resetAnalytics(): Promise<void> {
  await client?.cleanup();
  client = null;
  analyticsClient = null;
  initialized = false;
  setRealClient(null);
}
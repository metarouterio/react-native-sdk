import type { AnalyticsInterface } from '../types';

const pendingCalls: Array<() => void> = [];
const MAX_PENDING_CALLS = 20;
let realClient: AnalyticsInterface | null = null;

function handleMethodCall<T extends keyof AnalyticsInterface>(
  methodName: T,
  ...args: any[]
): any {
  if (realClient) {
    return (realClient[methodName] as any)(...args);
  }

  if (pendingCalls.length >= MAX_PENDING_CALLS) {
    // Drop the oldest call
    pendingCalls.shift();
    console.warn(`[MetaRouter] Proxy queue reached max size (${MAX_PENDING_CALLS}). Oldest call dropped.`);
  }

  pendingCalls.push(() => {
    if (realClient) {
      (realClient[methodName] as any)(...args);
    }
  });
}

/**
 * proxyClient implements a proxy pattern for the AnalyticsInterface.
 *
 * It allows analytics method calls (track, identify, etc.) to be made before the real analytics client
 * is fully initialized. Calls are queued and replayed once the real client is set via setRealClient.
 * This ensures that analytics events are not lost if called early in the app lifecycle.
 *
 * The proxy also provides a fallback for getDebugInfo, returning proxy state if the real client is not ready.
 *
 * Usage:
 *   - Use proxyClient as the default analytics client before initialization.
 *   - Call setRealClient(realClientInstance) once the real client is ready.
 */

export const proxyClient: AnalyticsInterface = {
  track: (event, props) => handleMethodCall('track', event, props),
  identify: (userId, traits) => handleMethodCall('identify', userId, traits),
  group: (groupId, traits) => handleMethodCall('group', groupId, traits),
  screen: (name, props) => handleMethodCall('screen', name, props),
  alias: (newUserId) => handleMethodCall('alias', newUserId),
  flush: () => handleMethodCall('flush'),
  cleanup: () => handleMethodCall('cleanup'),
  enableDebugLogging: () => handleMethodCall('enableDebugLogging'),
  getDebugInfo: () =>
    realClient?.getDebugInfo?.() ?? { proxy: true, pendingCalls: pendingCalls.length },
};

export function setRealClient(client: AnalyticsInterface | null) {
  realClient = client;

  if (client) {
    pendingCalls.forEach((fn) => fn());
    pendingCalls.length = 0;
  }
}
import type { AnalyticsInterface } from '../types';

const pendingCalls: Array<() => void> = [];
let realClient: AnalyticsInterface | null = null;

function handleMethodCall<T extends keyof AnalyticsInterface>(
  methodName: T,
  ...args: any[]
): any {
  if (realClient) {
    return (realClient[methodName] as any)(...args);
  }

  if (pendingCalls.length > 100) {
    console.warn(`[MetaRouter] Proxy queue exceeds 100 pending calls: ${methodName}`);
  }

  pendingCalls.push(() => {
    if (realClient) {
      (realClient[methodName] as any)(...args);
    }
  });
}

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
import type { AnalyticsInterface } from '../types';

const pendingCalls: Array<() => void> = [];
let realClient: AnalyticsInterface | null = null;

function handleMethodCall(methodName: keyof AnalyticsInterface, ...args: any[]) {
  if (realClient) {
    return (realClient[methodName] as Function)(...args);
  }

  pendingCalls.push(() => {
    if (realClient) {
      (realClient[methodName] as Function)(...args);
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
};

export function setRealClient(client: AnalyticsInterface | null) {
  realClient = client;
  if (client) {
    pendingCalls.forEach((fn) => fn());
    pendingCalls.length = 0;
  }
}
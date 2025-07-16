import type { AnalyticsInterface } from './MetaRouter';

const pendingCalls: Array<() => void> = [];

export const proxyClient: AnalyticsInterface = {
  track: (event, props) => {
    pendingCalls.push(() => client!.track(event, props));
  },
  identify: (userId, traits) => {
    pendingCalls.push(() => client!.identify(userId, traits));
  },
  group: (groupId, traits) => {
    pendingCalls.push(() => client!.group(groupId, traits));
  },
  screen: (name, props) => {
    pendingCalls.push(() => client!.screen(name, props));
  },
  alias: (newUserId) => {
    pendingCalls.push(() => client!.alias(newUserId));
  },
  flush: () => {
    pendingCalls.push(() => client!.flush());
  },
  cleanup: () => {
    pendingCalls.push(() => client!.cleanup());
  },
};

let client: AnalyticsInterface | null = null;

export function setRealClient(c: AnalyticsInterface) {
  client = c;

  // Flush pending
  pendingCalls.forEach((fn) => fn());
  pendingCalls.length = 0;
}
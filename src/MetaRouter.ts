import { createClient } from '@segment/analytics-react-native';
import type { Config, SegmentClient } from '@segment/analytics-react-native';
import { MetaRouterPlugin } from './MetaRouterPlugin';
import { proxyClient, setRealClient } from './proxyClient';

let analytics: SegmentClient | null = null;
let analyticsInterface: AnalyticsInterface | null = null;
let initialized = false;

export interface InitOptions {
  writeKey: string;
  ingestionEndpoint: string;
  debug?: boolean;
  flushAt?: number;
  flushInterval?: number;
  trackLifecycleEvents?: boolean;
  maxBatchSize?: number;
}

export type AnalyticsInterface = {
  track: (event: string, props?: Record<string, any>) => void;
  identify: (userId: string, traits?: Record<string, any>) => void;
  group: (groupId: string, traits?: Record<string, any>) => void;
  screen: (name: string, props?: Record<string, any>) => void;
  alias: (newUserId: string) => void;
  flush: () => void;
  cleanup: () => void;
};

export const MetaRouter = {
  init: async (options: InitOptions): Promise<AnalyticsInterface> => {
    if (initialized) return analyticsInterface!;

    if (!options.writeKey) throw new Error('writeKey is required');
    if (!options.ingestionEndpoint) throw new Error('ingestionEndpoint is required');

    const config: Config = {
      writeKey: options.writeKey,
      debug: options.debug,
      flushInterval: options.flushInterval,
      useSegmentEndpoints: false,
      trackAppLifecycleEvents: options.trackLifecycleEvents ?? true,
      autoAddSegmentDestination: false,
    };

    analytics = createClient(config);
    analytics.add({ plugin: new MetaRouterPlugin(options.ingestionEndpoint, options.writeKey) });
    await analytics.init();

    analyticsInterface = {
      track: (event, props) => analytics!.track(event, props),
      identify: (userId, traits) => analytics!.identify(userId, traits),
      group: (groupId, traits) => analytics!.group(groupId, traits),
      screen: (name, props) => analytics!.screen(name, props),
      alias: (newUserId) => analytics!.alias(newUserId),
      flush: () => analytics!.flush(),
      cleanup: () => analytics!.cleanup(),
    };

    initialized = true;

    // Hand off to proxy
    setRealClient(analyticsInterface);

    return analyticsInterface;
  },

  getClient(): AnalyticsInterface {
    return initialized ? analyticsInterface! : proxyClient;
  },

  create(opts: InitOptions): AnalyticsInterface {
    void this.init(opts).catch(console.error);
    return this.getClient();
  },

  reset: async () => {
    await analytics?.cleanup();
    analytics = null;
    analyticsInterface = null;
    initialized = false;
  },
};
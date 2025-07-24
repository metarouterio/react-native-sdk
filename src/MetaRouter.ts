import { initAnalytics, getAnalyticsClient, resetAnalytics } from './analytics/init';
import type { InitOptions as AnalyticsInitOptions } from './analytics/types';
import type { AnalyticsInterface } from './analytics/types';
import type { MetaRouterInterface } from './types';
import 'react-native-get-random-values';

/**
 * Top-level MetaRouter SDK interface.
 * 
 * Provides access to analytics methods for initialization, client retrieval, and reset.
 * Designed for use in React Native applications.
 *
 * Usage:
 *   import MetaRouter from '@metarouter/react-native-sdk';
 *   await MetaRouter.analytics.init({ ... });
 *   MetaRouter.analytics.track(...);
 */
export const MetaRouter: MetaRouterInterface = {
  analytics: {
    init: (opts: AnalyticsInitOptions): Promise<AnalyticsInterface> => initAnalytics(opts),
    getClient: (): AnalyticsInterface => getAnalyticsClient(),
    reset: (): Promise<void> => resetAnalytics(),
  },
};


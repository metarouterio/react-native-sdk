import { initAnalytics, getAnalyticsClient, resetAnalytics } from './analytics/init';
import type { InitOptions as AnalyticsInitOptions } from './analytics/types';
import type { AnalyticsInterface } from './analytics/types';
import type { MetaRouterInterface } from './types';
import 'react-native-get-random-values';

export const MetaRouter: MetaRouterInterface = {
  analytics: {
    init: (opts: AnalyticsInitOptions): Promise<AnalyticsInterface> => initAnalytics(opts),
    getClient: (): AnalyticsInterface => getAnalyticsClient(),
    reset: (): Promise<void> => resetAnalytics(),
  },
};


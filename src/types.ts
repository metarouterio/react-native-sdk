import type { InitOptions, AnalyticsInterface } from "./analytics/types";

export interface MetaRouterInterface {
  analytics: {
    init: (opts: InitOptions) => Promise<AnalyticsInterface>;
    getClient: () => AnalyticsInterface;
    reset: () => Promise<void>;
  };
}
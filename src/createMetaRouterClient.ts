import { MetaRouter } from './MetaRouter';
import type { AnalyticsInterface, InitOptions } from './MetaRouter';

export const createMetaRouterClient = (
  options: InitOptions
): AnalyticsInterface => {
  void MetaRouter.init(options).catch((err) => {
    console.error('[MetaRouter] init failed:', err);
  });

  return MetaRouter.getClient();
};
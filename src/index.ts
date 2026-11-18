export { createAnalyticsClient } from './analytics/init';

export { MetaRouterProvider } from './react/context';
export { useMetaRouter } from './react/useMetaRouter';
export type {
  InitOptions,
  AnalyticsInterface,
  ConfigError,
  WebViewBridgeProps,
  WebViewMessageEventLike,
  WebViewRefLike,
  JsonValue,
  ProviderContextMap,
  Consent,
  ConsentCategory,
} from './analytics/types';
export { OneTrustAdapter } from './analytics/consent/adapters/oneTrustAdapter';

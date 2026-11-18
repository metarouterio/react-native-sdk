/**
 * Whether this is a development build. Injectable so tests can exercise the
 * release path; production reads React Native's `__DEV__`. One switch for
 * every dev-only fail-fast in the SDK (config gate, consent registration).
 */
export const buildConfig = {
  isDevelopmentBuild: (): boolean =>
    typeof __DEV__ !== 'undefined' && __DEV__ === true,
};

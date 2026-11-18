let DeviceInfo: any = null;

try {
  DeviceInfo = require('react-native-device-info');
} catch {
  DeviceInfo = null;
}

/**
 * Snapshot of the host app's identity (name, version, build, bundle id).
 * Read once at SDK init and reused across every event — both as the `app:`
 * block on the EventContext and as version/build properties on lifecycle
 * events. Mirrors the iOS `AppContext` so a single source of truth flows
 * through the same places on both platforms.
 */
export interface AppContext {
  name: string;
  version: string;
  build: string;
  namespace: string;
}

/**
 * Reads the current app identity from `react-native-device-info`. Every field
 * falls back to 'unknown' when the package isn't installed (e.g. unit tests);
 * without its native module (Expo Go) device-info returns 'unknown' itself.
 * Never the SDK's own version: that would report the SDK as the app's version
 * and fire Application Updated on SDK upgrades instead of app updates.
 */
export function loadAppContext(): AppContext {
  return {
    name: DeviceInfo?.getApplicationName?.() ?? 'unknown',
    version: DeviceInfo?.getVersion?.() ?? 'unknown',
    build: DeviceInfo?.getBuildNumber?.() ?? 'unknown',
    namespace: DeviceInfo?.getBundleId?.() ?? 'unknown',
  };
}

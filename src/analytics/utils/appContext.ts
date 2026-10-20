import pkg from '../../../package.json';

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
 * Reads the current app identity from `react-native-device-info`. Falls back
 * to package.json version + 'unknown' for everything else if the native
 * module is missing (e.g. unit tests, Expo Go without the dev client).
 */
export function loadAppContext(): AppContext {
  return {
    name: DeviceInfo?.getApplicationName?.() ?? 'unknown',
    version: DeviceInfo?.getVersion?.() ?? pkg.version ?? 'unknown',
    build: DeviceInfo?.getBuildNumber?.() ?? 'unknown',
    namespace: DeviceInfo?.getBundleId?.() ?? 'unknown',
  };
}

import { getTimeZone } from './timezone';
import pkg from '../../../package.json';

let cachedContext: any = null;
let DeviceInfo: any = null;

try {
  DeviceInfo = require('react-native-device-info');
} catch {
  DeviceInfo = null;
}

export async function getContextInfo(): Promise<any> {
  if (cachedContext) return cachedContext;

  let locale = 'en-US';
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    locale = resolved.locale ?? locale;
  }

  cachedContext = {
    library: {
      name: 'metarouter-react-native-sdk',
      version: pkg.version ?? '0.0.0',
    },
    locale,
    timezone: getTimeZone(),
    device: {
      manufacturer: await DeviceInfo?.getManufacturer?.() ?? 'unknown',
      model: DeviceInfo?.getModel?.() ?? 'unknown',
      name: await DeviceInfo?.getDeviceName?.() ?? 'unknown',
      type: DeviceInfo?.getSystemName?.() === 'Android' ? 'android' : 'ios',
    },
    os: {
      name: DeviceInfo?.getSystemName?.() ?? 'unknown',
      version: DeviceInfo?.getSystemVersion?.() ?? 'unknown',
    },
    app: {
      name: DeviceInfo?.getApplicationName?.() ?? 'unknown',
      version: DeviceInfo?.getVersion?.() ?? pkg.version ?? 'unknown',
      build: DeviceInfo?.getBuildNumber?.() ?? 'unknown',
      namespace: DeviceInfo?.getBundleId?.() ?? 'unknown',
    },
    screen: {
      width: DeviceInfo?.getScreenWidth?.() ?? 0,
      height: DeviceInfo?.getScreenHeight?.() ?? 0,
      density: DeviceInfo?.getDensity?.() ?? 1,
    },
    network: {
      wifi: await DeviceInfo?.isWifiEnabled?.() ?? false,
    },
  };

  return cachedContext;
}
import { getTimeZone } from './timezone';
import pkg from '../../../package.json';

let DeviceInfo: any = null;
try {
  DeviceInfo = require('react-native-device-info');
} catch {
  DeviceInfo = null;
}

export function getContextInfo() {
  let locale = 'en-US';

  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    locale = resolved.locale ?? locale;
  }

  return {
    app: {
      name: DeviceInfo?.getApplicationName?.() ?? 'metarouter-react-native',
      version: DeviceInfo?.getVersion?.() ?? pkg.version ?? 'unknown',
      build: DeviceInfo?.getBuildNumber?.() ?? 'unknown',
      namespace: DeviceInfo?.getBundleId?.() ?? 'unknown',
    },
    device: {
      manufacturer: DeviceInfo?.getManufacturer?.() ?? 'unknown',
      model: DeviceInfo?.getModel?.() ?? 'unknown',
      name: DeviceInfo?.getDeviceName?.() ?? 'unknown',
      type: DeviceInfo?.getSystemName?.()?.toLowerCase() === 'android' ? 'android' : 'ios',
    },
    library: {
      name: 'metarouter-react-native-sdk',
      version: pkg.version ?? '0.0.0',
    },
    os: {
      name: DeviceInfo?.getSystemName?.() ?? 'unknown',
      version: DeviceInfo?.getSystemVersion?.() ?? 'unknown',
    },
    screen: {
      density: DeviceInfo?.getDensity?.() ?? 2,
      width: DeviceInfo?.getScreenWidth?.() ?? 0,
      height: DeviceInfo?.getScreenHeight?.() ?? 0,
    },
    network: {
      wifi: DeviceInfo?.isWifiEnabled?.() ?? true, // fallback to true if unknown
    },
    locale,
    timezone: getTimeZone(),
  };
}
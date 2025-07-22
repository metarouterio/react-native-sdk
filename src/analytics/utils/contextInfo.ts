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
    library: {
      name: 'metarouter-react-native-sdk',
      version: pkg.version ?? '0.0.0',
    },
    locale,
    timezone: getTimeZone(),
    device: {
      manufacturer: DeviceInfo?.getManufacturer?.() ?? 'unknown',
      model: DeviceInfo?.getModel?.() ?? 'unknown',
      osName: DeviceInfo?.getSystemName?.() ?? 'unknown',
      osVersion: DeviceInfo?.getSystemVersion?.() ?? 'unknown',
    },
    app: {
      version: DeviceInfo?.getVersion?.() ?? pkg.version ?? 'unknown',
      build: DeviceInfo?.getBuildNumber?.() ?? 'unknown',
    },
  };
}
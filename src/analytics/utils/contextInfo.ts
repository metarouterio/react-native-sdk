import { Dimensions, PixelRatio, Platform } from 'react-native';

import { getTimeZone } from './timezone';
import pkg from '../../../package.json';
import { EventContext } from '../types';
import { AppContext } from './appContext';

let cachedContext: EventContext | null = null;
let DeviceInfo: any = null;

try {
  DeviceInfo = require('react-native-device-info');
} catch {
  DeviceInfo = null;
}

/**
 * Gathers and caches device, app, and environment context information for analytics events.
 *
 * - Collects details such as device model/type, OS, screen size, locale and timezone.
 * - Uses `react-native-device-info` and the current environment to populate device/os fields.
 * - Reuses the caller-provided AppContext for the `app:` block so version/build
 *   are sourced from the same snapshot used by lifecycle events.
 * - Caches the result for the lifetime of the app to avoid redundant async calls.
 *   Only static fields belong here: network and the advertising ID change while
 *   the app runs, and enrichment stamps them per event.
 * - Returns a context object suitable for event enrichment.
 *
 * @param appContext - The host app identity snapshot (name, version, build, namespace).
 * @returns {Promise<EventContext>} A promise that resolves to the context information object.
 */
export async function getContextInfo(
  appContext: AppContext
): Promise<EventContext> {
  if (cachedContext) return cachedContext;

  let locale = 'en-US';
  if (
    typeof Intl !== 'undefined' &&
    typeof Intl.DateTimeFormat === 'function'
  ) {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    locale = resolved.locale ?? locale;
  }

  const { width, height } = Dimensions.get('screen');
  const density = Number(PixelRatio.get().toFixed(2));

  cachedContext = {
    library: {
      name: 'metarouter-react-native-sdk',
      version: pkg.version ?? '0.0.0',
    },
    locale,
    timezone: getTimeZone(),
    device: {
      manufacturer: (await DeviceInfo?.getManufacturer?.()) ?? 'unknown',
      model:
        Platform.OS === 'android'
          ? (DeviceInfo?.getModel?.() ?? 'unknown')
          : (DeviceInfo?.getDeviceId?.() ?? 'unknown'),
      type: DeviceInfo?.getSystemName?.() === 'Android' ? 'android' : 'ios',
      ...(Platform.OS === 'android'
        ? { name: (await DeviceInfo?.getDevice?.()) ?? 'unknown' }
        : {}),
    },
    os: {
      name: DeviceInfo?.getSystemName?.() ?? 'unknown',
      version: DeviceInfo?.getSystemVersion?.() ?? 'unknown',
    },
    app: {
      name: appContext.name,
      version: appContext.version,
      build: appContext.build,
      namespace: appContext.namespace,
    },
    screen: {
      width: Math.round(width),
      height: Math.round(height),
      density,
    },
  };

  return cachedContext;
}

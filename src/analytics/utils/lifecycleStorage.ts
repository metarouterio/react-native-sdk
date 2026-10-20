import AsyncStorage from '@react-native-async-storage/async-storage';

export const LIFECYCLE_VERSION_KEY = 'metarouter:lifecycle:version';
export const LIFECYCLE_BUILD_KEY = 'metarouter:lifecycle:build';

/**
 * Storage for app lifecycle state (last-seen version + build). Lives in a
 * dedicated module so neither IdentityManager.reset() nor the client's reset()
 * can wipe install/update history. Errors are swallowed so missing or
 * unavailable storage is treated as "no prior lifecycle state" — the caller
 * decides whether that means install or update.
 */

export async function getLifecycleVersion(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LIFECYCLE_VERSION_KEY);
  } catch {
    return null;
  }
}

export async function getLifecycleBuild(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LIFECYCLE_BUILD_KEY);
  } catch {
    return null;
  }
}

export async function setLifecycleVersionBuild(
  version: string,
  build: string
): Promise<void> {
  try {
    await AsyncStorage.setItem(LIFECYCLE_VERSION_KEY, version);
    await AsyncStorage.setItem(LIFECYCLE_BUILD_KEY, build);
  } catch {
    // best-effort; cold-launch state will be re-derived on next run
  }
}

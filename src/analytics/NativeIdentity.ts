import { NativeModules } from 'react-native';
import { warn } from './utils/logger';

interface NativeIdentityModule {
  getAnonymousId(): Promise<string | null>;
}

function getModule(): NativeIdentityModule | null {
  const mod = NativeModules.MetaRouterIdentity as
    | NativeIdentityModule
    | undefined;
  if (!mod) {
    warn(
      'MetaRouterIdentity native module is not available. getAnonymousId() will return null.'
    );
    return null;
  }
  return mod;
}

export async function getAnonymousId(): Promise<string | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    return await mod.getAnonymousId();
  } catch (err) {
    warn('Failed to get anonymous ID from native module:', err);
    return null;
  }
}

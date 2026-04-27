/**
 * Names + property keys for the four Application lifecycle events. Matches the
 * iOS/Android wire format exactly (Title Case event names, snake_case props).
 */

export const APPLICATION_INSTALLED = 'Application Installed';
export const APPLICATION_UPDATED = 'Application Updated';
export const APPLICATION_OPENED = 'Application Opened';
export const APPLICATION_BACKGROUNDED = 'Application Backgrounded';

export const PROP_VERSION = 'version';
export const PROP_BUILD = 'build';
export const PROP_PREVIOUS_VERSION = 'previous_version';
export const PROP_PREVIOUS_BUILD = 'previous_build';
export const PROP_FROM_BACKGROUND = 'from_background';
export const PROP_REFERRING_APPLICATION = 'referring_application';
export const PROP_URL = 'url';

/** Sentinel previous_version/previous_build for SDK upgrades from a pre-lifecycle build. */
export const UNKNOWN_PREVIOUS = 'unknown';

export interface VersionInfo {
  version: string;
  build: string;
}

export interface DeepLinkInfo {
  url?: string;
  referringApplication?: string;
}

type TrackFn = (event: string, properties?: Record<string, any>) => void;

/**
 * Thin emitter that wraps the client's track() with the lifecycle event
 * shapes. Honors the trackLifecycleEvents flag — when disabled every emit is a
 * no-op so callers do not need to gate at every call site.
 */
export class LifecycleEmitter {
  private readonly track: TrackFn;
  private readonly enabled: boolean;

  constructor(track: TrackFn, enabled: boolean) {
    this.track = track;
    this.enabled = enabled;
  }

  emitInstalled(info: VersionInfo): void {
    if (!this.enabled) return;
    this.track(APPLICATION_INSTALLED, {
      [PROP_VERSION]: info.version,
      [PROP_BUILD]: info.build,
    });
  }

  emitUpdated(
    info: VersionInfo,
    previous: { version: string; build: string }
  ): void {
    if (!this.enabled) return;
    this.track(APPLICATION_UPDATED, {
      [PROP_VERSION]: info.version,
      [PROP_BUILD]: info.build,
      [PROP_PREVIOUS_VERSION]: previous.version,
      [PROP_PREVIOUS_BUILD]: previous.build,
    });
  }

  emitOpened(
    info: VersionInfo,
    fromBackground: boolean,
    deepLink?: DeepLinkInfo
  ): void {
    if (!this.enabled) return;
    const props: Record<string, any> = {
      [PROP_FROM_BACKGROUND]: fromBackground,
      [PROP_VERSION]: info.version,
      [PROP_BUILD]: info.build,
    };
    if (deepLink?.url) {
      props[PROP_URL] = deepLink.url;
    }
    if (deepLink?.referringApplication) {
      props[PROP_REFERRING_APPLICATION] = deepLink.referringApplication;
    }
    this.track(APPLICATION_OPENED, props);
  }

  emitBackgrounded(): void {
    if (!this.enabled) return;
    this.track(APPLICATION_BACKGROUNDED, {});
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

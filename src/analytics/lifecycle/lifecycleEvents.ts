/**
 * Names + property keys for the four Application lifecycle events.
 */

import Dispatcher from '../dispatcher';
import { EnrichedEventPayload } from '../types';
import { AppContext } from '../utils/appContext';

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

/** Unknown previous_version/previous_build for SDK upgrades from a pre-lifecycle build. */
export const UNKNOWN_PREVIOUS = 'unknown';

export interface DeepLinkInfo {
  url?: string;
  referringApplication?: string;
}

/**
 * Builds a fully-enriched track-type EnrichedEventPayload (identity + writeKey
 * + context + messageId + timestamp). Provided by the analytics client so the
 * emitter does not need to know how identity/enrichment are wired.
 */
export type CreateTrackEvent = (
  event: string,
  properties?: Record<string, any>
) => EnrichedEventPayload;

/**
 * Thin emitter that wraps the dispatch path with the lifecycle event shapes.
 * Mirrors the iOS LifecycleEventEmitter: takes a Dispatcher and an enrichment
 * callable plus a process-stable AppContext, then constructs Installed /
 * Updated / Opened / Backgrounded payloads. Construct only when lifecycle
 * tracking is enabled; callers should skip construction entirely when the
 * flag is off.
 */
export class LifecycleEmitter {
  private readonly dispatcher: Dispatcher;
  private readonly createTrackEvent: CreateTrackEvent;
  private readonly appContext: AppContext;

  constructor(
    dispatcher: Dispatcher,
    createTrackEvent: CreateTrackEvent,
    appContext: AppContext
  ) {
    this.dispatcher = dispatcher;
    this.createTrackEvent = createTrackEvent;
    this.appContext = appContext;
  }

  emitInstalled(): void {
    this.dispatch(APPLICATION_INSTALLED, {
      [PROP_VERSION]: this.appContext.version,
      [PROP_BUILD]: this.appContext.build,
    });
  }

  emitUpdated(previous: { version: string; build: string }): void {
    this.dispatch(APPLICATION_UPDATED, {
      [PROP_VERSION]: this.appContext.version,
      [PROP_BUILD]: this.appContext.build,
      [PROP_PREVIOUS_VERSION]: previous.version,
      [PROP_PREVIOUS_BUILD]: previous.build,
    });
  }

  emitOpened(fromBackground: boolean, deepLink?: DeepLinkInfo): void {
    const props: Record<string, any> = {
      [PROP_FROM_BACKGROUND]: fromBackground,
      [PROP_VERSION]: this.appContext.version,
      [PROP_BUILD]: this.appContext.build,
    };
    if (deepLink?.url) {
      props[PROP_URL] = deepLink.url;
    }
    if (deepLink?.referringApplication) {
      props[PROP_REFERRING_APPLICATION] = deepLink.referringApplication;
    }
    this.dispatch(APPLICATION_OPENED, props);
  }

  emitBackgrounded(): void {
    this.dispatch(APPLICATION_BACKGROUNDED, {});
  }

  private dispatch(event: string, properties: Record<string, any>): void {
    const enriched = this.createTrackEvent(event, properties);
    this.dispatcher.enqueue(enriched);
  }
}

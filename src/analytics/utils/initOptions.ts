import type { ConfigError, InitOptions } from '../types';
import { warn as logWarn } from './logger';

/*
 * Why the options were invalid. Recorded instead of thrown: a throw from the
 * synchronous `createAnalyticsClient` call would take down a host that sources
 * its config remotely and forgot a try/catch — the crash this contract exists
 * to prevent. Each error carries its description, as `ConfigError.description`
 * does on iOS and Android, and the text is byte-identical with both SDKs so one
 * support answer covers all three.
 */
const emptyWriteKeyError = (): ConfigError => ({
  type: 'emptyWriteKey',
  description: 'writeKey must not be empty or whitespace-only',
});

const invalidIngestionHostError = (raw: string): ConfigError => ({
  type: 'invalidIngestionHost',
  raw,
  description: `ingestionHost must be an http(s) URL, got "${raw}"`,
});

export interface ValidatedInitOptions {
  /** Normalized copy: trimmed key/host, trailing slashes removed, numbers clamped. */
  options: InitOptions;
  /** First error found (writeKey before host), or null when valid. */
  configError: ConfigError | null;
}

// `http(s)://[userinfo@]host[:port][/path]`. Parsed by hand rather than with
// `URL`: React Native's `URL` polyfill does not implement `hostname`, so it
// cannot tell "https:" (no host) from a real origin. Accepts what Foundation
// and java.net.URL accept, so the same string passes on all three platforms:
// userinfo, an empty port ("host:"), and bracketed IPv6 hosts.
const HTTP_URL =
  /^(https?):\/\/(?:[^\s/?#@]*@)?(\[[^\]\s]+\]|[^\s/?#:@]+)(:\d*)?([/?#]\S*)?$/i;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** True for localhost / 127.0.0.1 / ::1 (IPv6 brackets stripped), exact match. */
export function isLoopbackHost(host: string): boolean {
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return LOOPBACK_HOSTS.has(bare);
}

/**
 * Single validation funnel, run once per `createAnalyticsClient` call — the
 * equivalent of the native InitOptions constructor. Never throws: records the
 * first error and clamps every numeric bound with a warning (one policy for
 * all fields, matching iOS and Android). Warnings are logged here and nowhere
 * else, so they appear once per call.
 */
export function validateInitOptions(
  raw: InitOptions,
  opts: { logWarnings?: boolean } = {}
): ValidatedInitOptions {
  const warn = opts.logWarnings === false ? () => {} : logWarn;
  let configError: ConfigError | null = null;

  const writeKey = typeof raw.writeKey === 'string' ? raw.writeKey.trim() : '';
  if (writeKey === '') {
    configError = emptyWriteKeyError();
  }

  const rawHost =
    typeof raw.ingestionHost === 'string' ? raw.ingestionHost : '';
  const ingestionHost = rawHost.trim().replace(/\/+$/, '');
  const match = HTTP_URL.exec(ingestionHost);
  if (!match) {
    if (configError === null) {
      configError = invalidIngestionHostError(rawHost);
    }
  } else if (match[1]!.toLowerCase() === 'http' && !isLoopbackHost(match[2]!)) {
    // A cleartext origin is spoofable in transit — legitimate for local
    // development, worth a warning anywhere else.
    warn(
      `ingestionHost ${ingestionHost} is cleartext http — use https outside local development.`
    );
  }

  // NaN / Infinity (e.g. Number('') from remote config) would slip past every
  // `<` check and reach the dispatcher as a 0ms flush loop or a silently
  // disabled disk queue. Treated as unset, with a warning. Native integer
  // options cannot hold these values, so only JS needs the check.
  const finiteOrUnset = (name: string, value: number | undefined) => {
    if (value == null || Number.isFinite(value)) return value;
    warn(`${name} (${value}) is not a finite number — using the default`);
    return undefined;
  };

  const flushIntervalSeconds = finiteOrUnset(
    'flushIntervalSeconds',
    raw.flushIntervalSeconds
  );
  if (flushIntervalSeconds != null && flushIntervalSeconds < 1) {
    warn(`flushIntervalSeconds (${flushIntervalSeconds}) clamped to 1`);
  }
  const maxQueueEvents = finiteOrUnset('maxQueueEvents', raw.maxQueueEvents);
  if (maxQueueEvents != null && maxQueueEvents < 1) {
    warn(`maxQueueEvents (${maxQueueEvents}) clamped to 1`);
  }
  const maxDiskEvents = finiteOrUnset('maxDiskEvents', raw.maxDiskEvents);
  if (maxDiskEvents != null && maxDiskEvents < 0) {
    warn(
      `maxDiskEvents (${maxDiskEvents}) clamped to 0 — use 0 to disable disk persistence`
    );
  }

  const clampedQueue = Math.max(1, maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS);
  const clampedDisk = Math.max(0, maxDiskEvents ?? DEFAULT_MAX_DISK_EVENTS);
  if (clampedDisk > 0 && clampedDisk < clampedQueue) {
    warn(
      `maxDiskEvents (${clampedDisk}) is less than maxQueueEvents (${clampedQueue}) — memory can hold more events than disk can preserve; events may be dropped during background flush`
    );
  }

  return {
    options: {
      ...raw,
      writeKey,
      ingestionHost,
      flushIntervalSeconds:
        flushIntervalSeconds != null
          ? Math.max(1, flushIntervalSeconds)
          : undefined,
      maxQueueEvents: clampedQueue,
      maxDiskEvents: clampedDisk,
    },
    configError,
  };
}

export const DEFAULT_MAX_QUEUE_EVENTS = 2000;
export const DEFAULT_MAX_DISK_EVENTS = 10_000;

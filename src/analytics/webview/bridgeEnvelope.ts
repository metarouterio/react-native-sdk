/**
 * Error codes returned to the web producer. Closed set — the web side may
 * branch on these, so adding a code is a contract change. The strings are the
 * exact wire values, identical on iOS and Android.
 */
export type BridgeErrorCode =
  | 'malformed_json'
  | 'malformed_payload'
  | 'missing_field'
  | 'unknown_type'
  | 'unsupported_version'
  | 'payload_too_large'
  | 'not_ready';

/** Point-in-time page facts stamped by the wrapper at call time. */
export interface PageContext {
  url?: string;
  path?: string;
  search?: string;
  title?: string;
  referrer?: string;
}

/**
 * A validated web→native bridge envelope (contract v1). Only produced by
 * parseBridgeEnvelope, so downstream code (merge, dedup) never re-validates.
 *
 * `sentAt` is the producer's untrusted clock (the SDK sets the real timestamp
 * at merge) and `source` distinguishes the injected wrapper from a future
 * web-SDK producer; both are carried, not consumed.
 */
export interface BridgeEnvelope {
  version: number;
  messageId: string;
  /** "track" or "page" in contract v1. */
  type: 'track' | 'page';
  name: string;
  properties: Record<string, unknown>;
  sentAt?: string;
  page?: PageContext;
  source?: { producer?: string; wrapperVersion?: string };
}

export type BridgeParseResult =
  | { valid: true; envelope: BridgeEnvelope }
  | {
      valid: false;
      code: BridgeErrorCode;
      message: string;
      /** Echoed when it could be extracted — absent for unparseable input. */
      messageId?: string;
      /** Set only for unsupported_version. */
      supportedVersion?: number;
    };

export const SUPPORTED_ENVELOPE_VERSION = 1;

/**
 * Max envelope size accepted at the untrusted page→SDK boundary: a policy cap
 * that bounds parse cost. 64 KiB sits well under the cluster's 250 KiB
 * single-event ingest cap, leaving headroom for enrichment.
 */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

// UUIDs are 36 chars; the ceiling keeps the dedup store bounded in bytes, not
// just entries — 1000 retained near-64 KB ids would be ~64 MB.
export const MAX_MESSAGE_ID_CHARS = 256;

/** UTF-8 byte length without allocating an encoded copy. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff
    ) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      i++;
    } else bytes += 3; // includes a lone surrogate, encoded as U+FFFD
  }
  return bytes;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringOrUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/**
 * Parses and validates a raw bridge message, with the same rules and messages
 * as the iOS and Android parsers.
 *
 * Validation order: size (before parsing, so an oversized payload is never
 * deserialized) → JSON → messageId → version → type → name → properties.
 * Unknown fields are ignored so the web side can add optional fields without a
 * version bump; optional fields of an unexpected type read as absent — only
 * `properties`, which the merge depends on, is strict.
 */
export function parseBridgeEnvelope(raw: string): BridgeParseResult {
  // A UTF-8 length is never below the UTF-16 length, so an over-length string
  // is oversized without counting bytes.
  if (
    raw.length > MAX_ENVELOPE_BYTES ||
    utf8ByteLength(raw) > MAX_ENVELOPE_BYTES
  ) {
    return invalid(
      'payload_too_large',
      `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`
    );
  }

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return invalid('malformed_json', 'envelope is not valid JSON');
  }
  if (!isObject(root)) {
    return invalid('malformed_payload', 'envelope must be a JSON object');
  }

  // Extracted first so later rejections can echo it in the error reply.
  const messageId = stringOrUndefined(root.messageId);
  if (!messageId || messageId.trim() === '') {
    return invalid('missing_field', 'messageId is required');
  }
  if (messageId.length > MAX_MESSAGE_ID_CHARS) {
    // Not echoed: the reply would amplify the same bytes back to the page.
    return invalid(
      'malformed_payload',
      `messageId exceeds ${MAX_MESSAGE_ID_CHARS} chars`
    );
  }

  if (root.version === undefined) {
    return invalid('missing_field', 'version is required', messageId);
  }
  const version = root.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return invalid(
      'malformed_payload',
      'version must be an integer',
      messageId
    );
  }
  if (version < 1) {
    return invalid('malformed_payload', 'version must be >= 1', messageId);
  }
  if (version > SUPPORTED_ENVELOPE_VERSION) {
    return {
      ...invalid(
        'unsupported_version',
        `envelope version ${version} > supported ${SUPPORTED_ENVELOPE_VERSION}`,
        messageId
      ),
      supportedVersion: SUPPORTED_ENVELOPE_VERSION,
    };
  }

  const type = stringOrUndefined(root.type);
  if (type === undefined) {
    return invalid('missing_field', 'type is required', messageId);
  }
  if (type !== 'track' && type !== 'page') {
    return invalid(
      'unknown_type',
      `type must be "track" or "page", got "${type}"`,
      messageId
    );
  }

  const name = stringOrUndefined(root.name);
  if (!name || name.trim() === '') {
    return invalid('missing_field', 'name is required', messageId);
  }

  let properties: Record<string, unknown>;
  if (root.properties === undefined || root.properties === null) {
    properties = {};
  } else if (isObject(root.properties)) {
    properties = root.properties;
  } else {
    return invalid(
      'malformed_payload',
      'properties must be a JSON object',
      messageId
    );
  }

  const envelope: BridgeEnvelope = {
    version,
    messageId,
    type,
    name,
    properties,
  };
  const sentAt = stringOrUndefined(root.sentAt);
  if (sentAt !== undefined) envelope.sentAt = sentAt;
  if (isObject(root.page)) {
    const page: PageContext = {};
    for (const key of ['url', 'path', 'search', 'title', 'referrer'] as const) {
      const value = stringOrUndefined(root.page[key]);
      if (value !== undefined) page[key] = value;
    }
    envelope.page = page;
  }
  if (isObject(root.source)) {
    envelope.source = {
      producer: stringOrUndefined(root.source.producer),
      wrapperVersion: stringOrUndefined(root.source.wrapperVersion),
    };
  }
  return { valid: true, envelope };
}

function invalid(
  code: BridgeErrorCode,
  message: string,
  messageId?: string
): Extract<BridgeParseResult, { valid: false }> {
  return messageId === undefined
    ? { valid: false, code, message }
    : { valid: false, code, message, messageId };
}

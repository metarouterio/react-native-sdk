import { warn } from '../../utils/logger';
import { canonicalize, type Consent } from '../consent';

const GROUPS_PREFIX = 'groups=';

/**
 * Percent-decoding only — `+` stays `+`, unlike form decoding — and null on a
 * malformed escape (`%G1`, a trailing `%`), so the caller keeps the raw value.
 * Bytes that are not valid UTF-8 decode to U+FFFD, as Java's URLDecoder does on
 * Android: decodeURIComponent would throw on them instead, and a cookie with one
 * such byte would then parse to no categories at all.
 */
export function percentDecoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // Fall through: malformed escape or invalid UTF-8; tell them apart below.
  }
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '%') {
      out += value[i];
      i++;
      continue;
    }
    const bytes: number[] = [];
    while (i < value.length && value[i] === '%') {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 3;
    }
    out += utf8DecodeLenient(bytes);
  }
  return out;
}

const REPLACEMENT = '\ufffd';

/**
 * UTF-8 bytes to a string, replacing malformed input exactly as Java's UTF-8
 * decoder does (URLDecoder on Android), so both SDKs produce the same category
 * keys from the same cookie: a valid prefix of a truncated sequence becomes ONE
 * U+FFFD, an invalid lead or stray continuation byte one each, and an encoded
 * surrogate (ED A0 80) one for the whole sequence.
 */
function utf8DecodeLenient(bytes: number[]): string {
  const isContinuation = (x: number | undefined) =>
    x !== undefined && (x & 0xc0) === 0x80;
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];
    const b4 = bytes[i + 3];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc2 && b <= 0xdf) {
      if (!isContinuation(b2)) {
        out += REPLACEMENT;
        i += 1;
        continue;
      }
      out += String.fromCharCode(((b & 0x1f) << 6) | (b2! & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (!isContinuation(b2) || (b === 0xe0 && b2! < 0xa0)) {
        out += REPLACEMENT;
        i += 1;
      } else if (!isContinuation(b3)) {
        out += REPLACEMENT;
        i += 2;
      } else {
        const cp = ((b & 0x0f) << 12) | ((b2! & 0x3f) << 6) | (b3! & 0x3f);
        out +=
          cp >= 0xd800 && cp <= 0xdfff ? REPLACEMENT : String.fromCharCode(cp);
        i += 3;
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (
        !isContinuation(b2) ||
        (b === 0xf0 && b2! < 0x90) ||
        (b === 0xf4 && b2! > 0x8f)
      ) {
        out += REPLACEMENT;
        i += 1;
      } else if (!isContinuation(b3)) {
        out += REPLACEMENT;
        i += 2;
      } else if (!isContinuation(b4)) {
        out += REPLACEMENT;
        i += 3;
      } else {
        out += String.fromCodePoint(
          ((b & 0x07) << 18) |
            ((b2! & 0x3f) << 12) |
            ((b3! & 0x3f) << 6) |
            (b4! & 0x3f)
        );
        i += 4;
      }
    } else {
      out += REPLACEMENT;
      i += 1;
    }
  }
  return out;
}

/**
 * The decoded `groups` list out of whatever the host passed: a bare list, a
 * cookie value, or a cookie jar. Tokens are split on both `&` (parameters
 * inside the cookie value) and `;` (cookie separators), so a `groups` that is
 * the last parameter of its cookie does not swallow the next cookie into its
 * last category. Null when the input is parameterized but has no usable
 * `groups` token.
 *
 * - A `groups=` token whose value holds no `key:value` pair is skipped, so an
 *   unrelated cookie named `groups` cannot shadow OptanonConsent's.
 * - `&`-joined input without a usable `groups` token is never parsed whole:
 *   other OneTrust parameters (`hosts=H1:1,H2:0`) share the `key:value` shape
 *   and would come out as phantom categories.
 * - Anything else is a bare list — or a whole value encoded once more
 *   (`groups%3DC0001%253A1`), which is decoded and searched again.
 */
function groupsList(input: string, depth = 0): string | null {
  for (const token of input.split(/[&;]/)) {
    let trimmed = token.trim();
    // In a cookie jar, `groups` can be the first parameter of the cookie's
    // value: `OptanonConsent=groups=…`. Look past one `name=` prefix.
    if (!trimmed.startsWith(GROUPS_PREFIX)) {
      const eq = trimmed.indexOf('=');
      if (eq >= 0 && trimmed.startsWith(GROUPS_PREFIX, eq + 1)) {
        trimmed = trimmed.slice(eq + 1);
      }
    }
    if (!trimmed.startsWith(GROUPS_PREFIX)) continue;
    const encoded = trimmed.slice(GROUPS_PREFIX.length);
    const decoded = percentDecoded(encoded) ?? encoded;
    if (decoded.includes(':')) return decoded;
  }
  if (input.includes('&')) return null;
  const decoded = percentDecoded(input) ?? input;
  if (depth === 0 && decoded.includes(GROUPS_PREFIX)) {
    return groupsList(decoded, 1);
  }
  return decoded;
}

/**
 * Booleans first, then numbers (1 = consented; `1.5` is not), then strings
 * (`"1"` / `"true"`, case-insensitive). Anything else counts as opted out: an
 * unreadable signal never opts a user in.
 */
function isOptedIn(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '1' || trimmed.toLowerCase() === 'true';
  }
  return false;
}

function fromStatuses(
  raw: Record<string, unknown>,
  explicit: boolean
): Consent {
  const optOut: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    Object.defineProperty(optOut, key, {
      value: !isOptedIn(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { explicit, optOut: Object.fromEntries(canonicalize(optOut)) };
}

function fromGroups(groups: string, explicit: boolean): Consent {
  const list = groupsList(groups);
  if (list === null) {
    if (groups.trim() !== '') {
      warn(
        'OneTrustAdapter: no `groups` parameter found — expected the OptanonConsent `groups` value, e.g. "C0001:1,C0002:0"'
      );
    }
    return fromStatuses({}, explicit);
  }
  const raw: [string, string][] = [];
  for (const segment of list.split(',')) {
    const colon = segment.indexOf(':');
    if (colon < 0) continue;
    const key = segment.slice(0, colon).trim();
    const value = segment.slice(colon + 1).trim();
    if (key === '' || key.includes('=')) continue;
    raw.push([key, value]);
  }
  if (raw.length === 0 && list.trim() !== '') {
    warn(
      'OneTrustAdapter: no category statuses found in groups value — expected the OptanonConsent `groups` parameter, e.g. "C0001:1,C0002:0"'
    );
  }
  return fromStatuses(Object.fromEntries(raw), explicit);
}

/**
 * Translates a OneTrust consent payload into the canonical Consent shape, to
 * pass to `setConsent`. Pure: no state, no dependency on the OneTrust SDK.
 * Reconciliation against the registered categories happens in setConsent, not
 * here, so register the set you gate on once and feed whatever OneTrust emits.
 *
 * OneTrust reports opt-IN status (1 / true = consented); the canonical shape is
 * opt-OUT, so the inversion happens here, once. Keys are lowercased
 * (`C0004` → `c0004`) to match the web SDK.
 *
 * Do not call setConsent with the result of an absent cookie: an empty `groups`
 * value reports no categories, so each registered category takes its default
 * as an explicit choice the user never made — a rejection for categories that
 * default to opted out, an opt-in for any with `defaultOptOut: false`; with
 * none registered yet, nothing blocked until they are, then each default as
 * that same explicit choice.
 */
export const OneTrustAdapter = {
  /**
   * @param raw Either OneTrust category statuses keyed by category ID
   *   (`{ C0001: 1, C0002: 0 }`; booleans, numbers or `"1"`/`"true"`), or the
   *   OptanonConsent cookie's `groups` value (`"C0001:1,C0002:0"`), still
   *   percent-encoded, the whole cookie value, or a full `document.cookie`.
   * @param explicit Whether this snapshot reflects an explicit user choice (a
   *   banner interaction) or a regional default; only the host knows which
   *   OneTrust callback fired.
   */
  normalize(raw: Record<string, unknown> | string, explicit: boolean): Consent {
    return typeof raw === 'string'
      ? fromGroups(raw, explicit)
      : fromStatuses(raw ?? {}, explicit);
  },
};

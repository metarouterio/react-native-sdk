import uuid from 'react-native-uuid';
import { log, warn } from '../utils/logger';
import { isLoopbackHost } from '../utils/initOptions';
import type { BridgeMessageProcessor } from './bridgeMessageProcessor';
import {
  BRIDGE_MESSAGE_PREFIX,
  DEFAULT_BRIDGE_OBJECT_NAME,
  buildBridgeWrapperScript,
  buildReplyScript,
} from './bridgeWrapperScript';
import type {
  WebViewBridgeProps,
  WebViewMessageEventLike,
  WebViewRefLike,
} from '../types';

// Origin rules must be scheme://host[:port] — anything else (paths, trailing
// slashes, wildcards) silently never matches the exact-origin checks. The host
// alternation carries bracketed IPv6 literals so http://[::1]:3000 reaches the
// loopback check instead of being rejected as malformed.
const ORIGIN_RULE = /^https?:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d+)?$/;

// Origin of a message's sending frame. react-native-webview reports a full URL
// on iOS (frameInfo.request.URL) and the origin on Android (sourceOrigin).
// Backslash ends the authority as it does for browsers in http(s) URLs, so
// "https://evil.com\@shop.example.com" reads as evil.com, not shop.example.com.
const URL_ORIGIN =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^/?#@\\]*@)?(\[[^\]\\]*\]|[^/?#:@\\]*)(?::(\d*))?(?:[/?#\\]|$)/;

/**
 * Scheme and host are case-insensitive and default ports are implied, but both
 * origin checks compare exact canonical strings: "https://Shop.Example.com:443"
 * would pass validation yet never match, leaving the bridge silently inert.
 * Same normalization as iOS.
 */
export function normalizeOrigin(origin: string): string {
  let normalized = origin.toLowerCase();
  if (normalized.startsWith('https://') && normalized.endsWith(':443')) {
    normalized = normalized.slice(0, -4);
  } else if (normalized.startsWith('http://') && normalized.endsWith(':80')) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

/** Canonical origin of a URL or origin string, or null when it has none. */
export function originOf(url: string | undefined): string | null {
  if (typeof url !== 'string') return null;
  const match = URL_ORIGIN.exec(url);
  if (!match || !match[2]) return null;
  const port = match[3] ? `:${match[3]}` : '';
  return normalizeOrigin(`${match[1]}://${match[2]}${port}`);
}

/**
 * Per-processor state. The token goes into the message prefix only the
 * main-frame wrapper knows. On Android without WEB_MESSAGE_LISTENER,
 * react-native-webview exposes its channel to every frame and reports the
 * main page's URL for every message, so the origin check alone would let a
 * cross-origin iframe (an ad) inside an allowlisted page post events. The
 * iframe cannot read the parent page's script, so it cannot forge the token.
 *
 * The token does not hide from main-frame scripts on an allowed page, and is
 * not meant to: those are trusted already — they can call metarouterBridge
 * directly, or wrap ReactNativeWebView.postMessage and read the prefix — so
 * keeping it out of the wrapper's function source would protect nothing. It
 * comes from react-native-uuid (Math.random in the app's JS engine, which no
 * page can observe), and lives as long as the processor: init.ts's processor
 * is one per app process, across reset() and re-init. A token that changed
 * between renders would orphan every page loaded under the previous one.
 */
interface BridgeState {
  messagePrefix: string;
  // Built props per raw origin list: attachWebView runs on every render, and
  // rebuilding the ~4 KB wrapper (and re-validating) each time is waste.
  // Bounded — a host deriving origins from state must not grow it forever.
  attachments: Map<string, Attachment>;
  noRefLogged: boolean;
}

const MAX_CACHED_ATTACHMENTS = 8;

interface Attachment {
  script: string;
  origins: string[];
  allowed: Set<string>;
}

const states = new WeakMap<BridgeMessageProcessor, BridgeState>();

function stateFor(processor: BridgeMessageProcessor): BridgeState {
  let state = states.get(processor);
  if (!state) {
    state = {
      messagePrefix: `${BRIDGE_MESSAGE_PREFIX}${String(uuid.v4())}:`,
      attachments: new Map(),
      noRefLogged: false,
    };
    states.set(processor, state);
  }
  return state;
}

// Refused origin lists already warned about — attachWebView runs on every
// render, and the warning would otherwise repeat on each one.
const warnedRefusals = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warnedRefusals.has(key)) return;
  warnedRefusals.add(key);
  warn(message);
}

// Returned when the attach is refused: the host's own messages keep flowing,
// and the empty script is safe to join with the host's own. Bridge messages
// are still claimed (and dropped): a page loaded under an earlier, valid
// attach keeps posting, and its envelopes must not reach the host's handler.
const inertProps = (): WebViewBridgeProps => ({
  injectedJavaScriptBeforeContentLoaded: '',
  onMessage: (event) => {
    const data = event?.nativeEvent?.data;
    return typeof data === 'string' && data.startsWith(BRIDGE_MESSAGE_PREFIX);
  },
});

// Never throws: JSON.stringify does on a BigInt or a cyclic entry, which an
// untyped caller (remote config) can pass, and attachWebView runs in render.
function cacheKey(allowedOrigins: readonly string[]): string | null {
  if (!Array.isArray(allowedOrigins)) return null;
  try {
    return JSON.stringify(allowedOrigins);
  } catch {
    return null;
  }
}

function validate(allowedOrigins: readonly string[]): Attachment | null {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    warnOnce('[]', 'attachWebView called with no allowed origins — ignoring.');
    return null;
  }
  if (allowedOrigins.some((o) => typeof o !== 'string')) {
    warnOnce(
      '<non-string>',
      'attachWebView rejects non-string origin rules — use explicit scheme://host[:port] strings.'
    );
    return null;
  }
  // Normalized before validating: the pattern is case-sensitive, so a
  // case-variant scheme would otherwise be rejected for a problem the host
  // does not have.
  const origins = allowedOrigins.map(normalizeOrigin);
  const key = JSON.stringify(origins);
  const invalid = origins.filter((o) => !ORIGIN_RULE.test(o));
  if (invalid.length > 0) {
    // Origin scoping is the bridge's security boundary; a wildcard would let
    // any page loaded in this WebView inject events into the queue.
    warnOnce(
      key,
      `attachWebView rejects invalid origin rules ${JSON.stringify(invalid)} — use explicit scheme://host[:port] origins.`
    );
    return null;
  }
  const insecure = origins.filter(
    (o) => o.startsWith('http://') && !isLoopbackHost(ORIGIN_RULE.exec(o)![1]!)
  );
  if (insecure.length > 0) {
    // A cleartext origin is spoofable in transit and the origin check then
    // trusts it — fine for local development, worth a warning elsewhere.
    warnOnce(
      key,
      `attachWebView: cleartext origin rules ${JSON.stringify(insecure)} — use https origins outside local development.`
    );
  }
  return { script: '', origins, allowed: new Set(origins) };
}

/**
 * Builds the props that bridge one `react-native-webview` WebView. Same
 * validation and warnings as the native attachWebView; differences forced by
 * react-native-webview:
 *
 * - There is no WebView object to register on, so the bridge is the returned
 *   props: the wrapper for `injectedJavaScriptBeforeContentLoaded` and an
 *   `onMessage` handler that returns true for the SDK's messages and false for
 *   the host's, so the host can chain its own handler.
 * - The message channel is not origin-scoped, so each message's reported
 *   sending-frame URL is checked against the allowlist, and must carry the
 *   session token only the main-frame wrapper holds (see BridgeState). The
 *   wrapper's own origin self-check is the page half. Failing messages are
 *   dropped with no reply — a hostile frame gets silence, not an oracle.
 * - The wrapper reaches the main frame only, and on Android
 *   react-native-webview runs it when the page starts loading rather than at
 *   document start, so page code that runs before it finds no bridge.
 * - Replies need the WebView ref (`injectJavaScript`), and go to the page in
 *   the main frame at reply time. Without a ref, events still flow and the
 *   page receives no acks.
 * - Calling it again (e.g. on every render) returns equivalent props; dedup
 *   lives in the shared processor.
 */
export function attachWebViewBridge(
  webViewRef: WebViewRefLike | null | undefined,
  allowedOrigins: readonly string[],
  processor: BridgeMessageProcessor
): WebViewBridgeProps {
  const state = stateFor(processor);
  const key = cacheKey(allowedOrigins);
  let attachment = key === null ? undefined : state.attachments.get(key);
  if (!attachment) {
    const validated = key === null ? null : validate(allowedOrigins);
    if (!validated) {
      if (key === null) {
        warnOnce(
          '<unserializable>',
          'attachWebView rejects origin rules that are not an array of strings.'
        );
      }
      return inertProps();
    }
    validated.script = buildBridgeWrapperScript(
      validated.origins,
      DEFAULT_BRIDGE_OBJECT_NAME,
      state.messagePrefix
    );
    attachment = validated;
    if (state.attachments.size >= MAX_CACHED_ATTACHMENTS) {
      state.attachments.delete(state.attachments.keys().next().value!);
    }
    state.attachments.set(key!, attachment);
    log(
      `WebView bridge attached (origins=${JSON.stringify(attachment.origins)})`
    );
  }
  const { script, origins, allowed } = attachment;

  const onMessage = (event: WebViewMessageEventLike): boolean => {
    const data = event?.nativeEvent?.data;
    if (typeof data !== 'string' || !data.startsWith(BRIDGE_MESSAGE_PREFIX)) {
      return false;
    }
    if (!data.startsWith(state.messagePrefix)) {
      // A bridge-shaped message without the token: a frame that never
      // received the wrapper. Debug-level — a hostile frame could spam this.
      log('WebView bridge dropped a message without a valid token');
      return true;
    }
    const origin = originOf(event.nativeEvent.url);
    if (origin === null || !allowed.has(origin)) {
      log(
        `WebView bridge dropped message from non-allowlisted origin ${origin}`
      );
      return true;
    }
    const reply = processor.process(data.slice(state.messagePrefix.length));
    const webView = webViewRef?.current;
    if (webView && typeof webView.injectJavaScript === 'function') {
      try {
        webView.injectJavaScript(
          buildReplyScript(JSON.stringify(reply), origins)
        );
      } catch (err) {
        // A page that navigated away mid-ack fails here routinely.
        log('WebView bridge reply delivery failed:', err);
      }
    } else if (!state.noRefLogged) {
      state.noRefLogged = true;
      log(
        'WebView bridge: no WebView ref passed to attachWebView — events are captured, replies are not delivered.'
      );
    }
    return true;
  };

  return { injectedJavaScriptBeforeContentLoaded: script, onMessage };
}

/** The message prefix (with token) the processor's wrapper posts with. Tests only. */
export function bridgeMessagePrefixFor(
  processor: BridgeMessageProcessor
): string {
  return stateFor(processor).messagePrefix;
}

export const DEFAULT_BRIDGE_OBJECT_NAME = 'metarouterBridge';

/**
 * Name of the `window` channel object the wrapper posts through and whose
 * `onmessage` receives replies — the same name, and the same page-visible
 * surface, as the iOS and Android SDKs.
 */
export const NATIVE_CHANNEL_NAME = '__metaRouterNativeChannel';

/**
 * Prefix on every bridge message. `window.ReactNativeWebView.postMessage` is
 * one channel shared with the host's own page→app messages (native has a
 * dedicated one), so the prefix is what lets the SDK claim its messages and
 * pass everything else through to the host untouched. The wrapper appends a
 * per-session token after it (see attachWebViewBridge).
 */
export const BRIDGE_MESSAGE_PREFIX = '__metaRouterBridge:';

export const WRAPPER_VERSION = '1.0.0';

/**
 * Builds the wrapper injected at document start (via
 * `injectedJavaScriptBeforeContentLoaded`). Identical to the iOS and Android
 * wrapper except for the channel shim:
 *
 * - Defines `window.metarouterBridge` with `track`/`page`, wraps each call in
 *   an envelope — minting `messageId` and stamping the page facts at call time
 *   — and posts it as a JSON string. `messageId` must be minted here: an id
 *   assigned at receipt would give two deliveries of one message two ids.
 * - Self-checks `location.origin` against the allowlist and defines nothing on
 *   other pages. `react-native-webview` has no origin-scoped channel, so this
 *   check plus the SDK's check of the sending frame's URL carry the security
 *   model together, as on iOS.
 * - The channel shim posts through `window.ReactNativeWebView`, resolved at
 *   call time, and exposes a settable `onmessage` that replies are delivered to.
 * - `properties` may be an object or a JSON string; a string that fails to
 *   parse is forwarded as-is so the SDK rejects it with `malformed_payload`.
 * - JSON.stringify is guarded: unstringifiable properties (circular, BigInt)
 *   are coerced to a string and re-posted, so the page gets a coded error
 *   reply, never a TypeError thrown into its own calling code.
 */
export function buildBridgeWrapperScript(
  allowedOrigins: readonly string[],
  bridgeObjectName: string = DEFAULT_BRIDGE_OBJECT_NAME,
  messagePrefix: string = BRIDGE_MESSAGE_PREFIX
): string {
  if (allowedOrigins.length === 0) {
    throw new Error('allowedOrigins must not be empty');
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bridgeObjectName)) {
    throw new Error('bridgeObjectName must be a valid JS identifier');
  }
  // JSON-encoding the allowlist keeps a hostile origin string from breaking
  // out of the script — quotes arrive escaped.
  const originsJsArray = JSON.stringify(allowedOrigins);
  const prefix = JSON.stringify(messagePrefix);

  return `(function() {
  'use strict';
  var ALLOWED_ORIGINS = ${originsJsArray};
  if (ALLOWED_ORIGINS.indexOf(location.origin) === -1) { return; }
  if (window.${bridgeObjectName}) { return; }

  if (!window.${NATIVE_CHANNEL_NAME}) {
    window.${NATIVE_CHANNEL_NAME} = {
      onmessage: null,
      postMessage: function(data) {
        if (window.ReactNativeWebView &&
            typeof window.ReactNativeWebView.postMessage === 'function') {
          window.ReactNativeWebView.postMessage(${prefix} + data);
        }
      }
    };
  }

  function uuidv4() {
    if (window.crypto && window.crypto.getRandomValues) {
      var b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = [];
      for (var i = 0; i < 16; i++) { h.push((b[i] + 0x100).toString(16).slice(1)); }
      return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
             h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
             h.slice(10, 16).join('');
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function post(type, name, properties) {
    if (typeof name !== 'string' || name.length === 0) { return; }
    var props = properties;
    if (typeof props === 'string') {
      try { props = JSON.parse(props); } catch (e) { /* forward as-is; native rejects */ }
    }
    if (props === undefined || props === null) { props = {}; }
    var envelope = {
      version: 1,
      messageId: uuidv4(),
      type: type,
      name: name,
      properties: props,
      sentAt: new Date().toISOString(),
      page: {
        url: location.href,
        path: location.pathname,
        search: location.search,
        title: document.title,
        referrer: document.referrer
      },
      source: { producer: 'wrapper', wrapperVersion: '${WRAPPER_VERSION}' }
    };
    var channel = window.${NATIVE_CHANNEL_NAME};
    if (!channel || typeof channel.postMessage !== 'function') { return; }
    var payload;
    try {
      payload = JSON.stringify(envelope);
    } catch (e) {
      try { envelope.properties = String(props); } catch (e2) { envelope.properties = 'unserializable'; }
      payload = JSON.stringify(envelope);
    }
    channel.postMessage(payload);
  }

  window.${bridgeObjectName} = {
    track: function(name, properties) { post('track', name, properties); },
    page: function(name, properties) { post('page', name, properties); }
  };
})();
true;`;
}

/**
 * Reply delivery script, run in the page with the WebView ref's
 * `injectJavaScript`. The reply JSON rides as a JS string literal, so the
 * page-visible shape matches iOS and Android: `onmessage` receives an
 * event-like object whose `data` is the reply string. The trailing `true;` is
 * what react-native-webview asks injected scripts to end with.
 *
 * `injectJavaScript` runs in whatever page is in the main frame when the reply
 * is sent, not in the frame that sent the message (iOS and Android reply to the
 * source frame). The origin guard keeps a reply from reaching a page the
 * WebView navigated to in between.
 */
export function buildReplyScript(
  replyJson: string,
  allowedOrigins: readonly string[]
): string {
  const channel = `window.${NATIVE_CHANNEL_NAME}`;
  return `${JSON.stringify(allowedOrigins)}.indexOf(location.origin) !== -1 && ${channel} && typeof ${channel}.onmessage === 'function' && ${channel}.onmessage({ data: ${jsStringLiteral(replyJson)} }); true;`;
}

/**
 * JSON.stringify leaves U+2028/U+2029 unescaped; engines before ES2019 read
 * them as line terminators, so page-controlled text echoed in a reply (a
 * messageId, an unknown type) would turn the reply script into a SyntaxError.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

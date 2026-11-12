import { NativeModules, Platform } from 'react-native';
import { warn } from '../utils/logger';

interface NativeWebViewSupportModule {
  isWebMessageListenerSupported(): boolean;
}

// Resolved once: the WebView provider does not change while the app runs,
// and attachWebView asks on every render.
let supported: boolean | undefined;

/**
 * Whether the bridge can attach on this device. Always true on iOS, whose
 * WKWebView reports each message's real sending frame. On
 * Android it needs the WebView provider's WEB_MESSAGE_LISTENER (WebView 82+):
 * without it react-native-webview reports the main page's URL for messages
 * from every frame, and the origin check cannot keep a cross-origin iframe
 * out. Same policy as the Android SDK, which refuses to attach there.
 *
 * Fails closed: other platforms (not checked), a missing native module (an
 * app not rebuilt since upgrading, Expo Go) or a failing synchronous call also
 * refuse, with the reason in the warning.
 */
export function isBridgeSupported(): boolean {
  if (supported !== undefined) return supported;
  if (Platform.OS === 'ios') {
    supported = true;
    return supported;
  }
  if (Platform.OS !== 'android') {
    warn(
      `WebView bridge unavailable on ${Platform.OS}: only iOS and Android are supported. WebView events will not be captured.`
    );
    supported = false;
    return supported;
  }
  const mod = NativeModules.MetaRouterWebViewSupport as
    | NativeWebViewSupportModule
    | undefined;
  if (!mod) {
    warn(
      'WebView bridge unavailable: the MetaRouterWebViewSupport native module is missing (rebuild the app after upgrading). WebView events will not be captured.'
    );
    supported = false;
    return supported;
  }
  try {
    supported = mod.isWebMessageListenerSupported() === true;
  } catch (err) {
    warn(
      'WebView bridge unavailable: the WebView feature check failed. WebView events will not be captured.',
      err
    );
    supported = false;
    return supported;
  }
  if (!supported) {
    warn(
      "WebView bridge unavailable: this device's WebView provider lacks WEB_MESSAGE_LISTENER. WebView events will not be captured."
    );
  }
  return supported;
}

/** Forgets the cached answer. Tests only. */
export function resetBridgeSupportForTests(): void {
  supported = undefined;
}

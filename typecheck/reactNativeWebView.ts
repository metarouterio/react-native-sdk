// Compile-time check that the bridge's props and ref types fit
// react-native-webview's own; the devDependency pins the version checked.
// Run by `npm run typecheck` (CI), never built or shipped.
import { createRef } from 'react';
import type { WebView, WebViewProps } from 'react-native-webview';
import type { WebViewBridgeProps, WebViewRefLike } from '../src';

export function typeChecks(bridge: WebViewBridgeProps) {
  // Spread onto <WebView> as returned.
  const spread: Pick<
    WebViewProps,
    'injectedJavaScriptBeforeContentLoaded' | 'onMessage'
  > = bridge;

  // Chained with the host's own handler.
  const chained: WebViewProps['onMessage'] = (event) => {
    if (!bridge.onMessage(event)) {
      // host handling
    }
  };

  // A useRef/createRef of the WebView is accepted as the reply ref.
  const ref: WebViewRefLike = createRef<WebView>();

  return [spread, chained, ref];
}

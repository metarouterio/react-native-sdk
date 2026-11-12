package com.metarouter.reactnative

import androidx.webkit.WebViewFeature
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Whether this device's WebView provider supports WEB_MESSAGE_LISTENER. Without
 * it react-native-webview falls back to addJavascriptInterface, which every
 * frame can call and which reports the main page's URL for every message, so
 * the bridge's origin check cannot tell an iframe from the page. The Android
 * SDK refuses to attach there; the RN bridge does the same.
 *
 * DOCUMENT_START_SCRIPT, the Android SDK's other requirement, is not checked:
 * react-native-webview never uses it, so it would refuse nothing extra.
 */
class MetaRouterWebViewSupportModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterWebViewSupport"

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isWebMessageListenerSupported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
}

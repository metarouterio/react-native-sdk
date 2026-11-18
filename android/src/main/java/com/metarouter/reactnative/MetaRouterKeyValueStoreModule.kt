package com.metarouter.reactnative

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Synchronous string store for state that must be known before host code runs:
 * consent and provider context. AsyncStorage resolves after the first host line,
 * so a synchronous getConsent() there could only report defaults — the Android
 * SDK reads SharedPreferences synchronously and has no such window.
 *
 * Its own preferences file: the Android SDK's files in a hybrid app stay apart.
 */
class MetaRouterKeyValueStoreModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    // Opened here so the file starts loading before the first read blocks on it.
    // Stricter than the Android SDK, which catches a failed open at startup: a
    // direct-boot-aware app that starts React Native before the first unlock
    // cannot open credential-encrypted preferences, and this throw would fail
    // React Native startup. Accepted: an activity cannot launch before unlock
    // unless the app itself is direct-boot aware, which this SDK's hosts are not.
    private val prefs = reactContext.getSharedPreferences(
        "com.metarouter.reactnative.store",
        Context.MODE_PRIVATE
    )

    override fun getName(): String = "MetaRouterKeyValueStore"

    /** Null when nothing is stored under [key]. */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getSync(key: String): String? = prefs.getString(key, null)

    /**
     * Synchronous so writes land in call order; a null [value] removes the key.
     * commit(), not apply(): a consent withdrawal or clear must survive the
     * process dying right after it. Writes are rare and small. Returns whether
     * the write reached disk: a blocking method must return a value to stay
     * synchronous under the new architecture.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun setSync(key: String, value: String?): Boolean {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        return editor.commit()
    }
}

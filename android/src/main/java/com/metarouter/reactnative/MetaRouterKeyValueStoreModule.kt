package com.metarouter.reactnative

import android.content.Context
import android.content.SharedPreferences
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Synchronous string store for state that must be known before host code runs:
 * provider context. AsyncStorage resolves after the first host line, so a
 * synchronous read there could only report this launch's values — the Android
 * SDK reads SharedPreferences synchronously and has no such window.
 *
 * Its own preferences file: the Android SDK's files in a hybrid app stay apart.
 */
class MetaRouterKeyValueStoreModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    // Opened here so the file starts loading before the first read blocks on it.
    // Null when the open failed: on Android 8+, an app targeting 8+ that is
    // direct-boot aware and starts React Native before the first unlock cannot
    // open credential-encrypted preferences. The methods retry the open and
    // throw while it still fails, which JS reads as unreadable storage: that
    // launch keeps these values in memory instead of failing startup, and a
    // clear made after unlock is still saved. Below that target the open
    // succeeds and reads empty before unlock, so a save can replace the stored
    // values; not guarded.
    @Volatile private var opened: SharedPreferences? = try {
        open()
    } catch (_: Exception) {
        null
    }

    private fun open(): SharedPreferences =
        reactApplicationContext.getSharedPreferences(
            "com.metarouter.reactnative.store",
            Context.MODE_PRIVATE
        )

    private val prefs: SharedPreferences
        get() = opened ?: try {
            open().also { opened = it }
        } catch (e: Exception) {
            // The cause goes in the message: React Native drops it on the way
            // to JS, where the SDK logs the error.
            throw IllegalStateException(
                "MetaRouterKeyValueStore: preferences could not be opened: $e",
                e
            )
        }

    override fun getName(): String = "MetaRouterKeyValueStore"

    /** Null when nothing is stored under [key]. */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getSync(key: String): String? = prefs.getString(key, null)

    /**
     * Synchronous so writes land in call order; a null [value] removes the key.
     * commit(), not apply(): a clear must survive the process dying right after
     * it. Writes are rare and small. Returns whether the write reached disk: a
     * blocking method must return a value to stay synchronous under the new
     * architecture.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun setSync(key: String, value: String?): Boolean {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        return editor.commit()
    }
}

package com.metarouter.reactnative

import android.os.SystemClock
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Synchronous monotonic clock for session inactivity. elapsedRealtime keeps
 * counting through deep sleep; uptimeMillis (and the CLOCK_MONOTONIC behind
 * React Native's performance.now) does not, so a phone left asleep for hours
 * would resume into the same session. Same clock as the Android SDK's
 * SessionManager.
 */
class MetaRouterClockModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterClock"

    // Double: the bridge has no Long, and ms since boot fits a double exactly.
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun continuousMillis(): Double = SystemClock.elapsedRealtime().toDouble()
}

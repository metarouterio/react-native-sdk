package com.metarouter.reactnative

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class MetaRouterIdentityModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterIdentity"

    @ReactMethod
    fun getAnonymousId(promise: Promise) {
        try {
            val anonymousId = com.metarouter.analytics.MetaRouter.Analytics.client()?.getAnonymousId()
            promise.resolve(anonymousId)
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }
}

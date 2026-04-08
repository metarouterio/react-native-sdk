package com.metarouter.reactnative

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule

class MetaRouterNetworkMonitorModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterNetworkMonitor"

    @Volatile
    private var isConnected: Boolean = true

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    init {
        connectivityManager = try {
            reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        } catch (_: Exception) {
            null
        }

        // Snapshot initial state
        connectivityManager?.let { cm ->
            isConnected = try {
                val network = cm.activeNetwork
                val caps = network?.let { cm.getNetworkCapabilities(it) }
                caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            } catch (_: Exception) {
                true // fallback
            }
        }

        // Register callback for changes
        connectivityManager?.let { cm ->
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (!isConnected) {
                        isConnected = true
                        sendEvent(true)
                    }
                }

                override fun onLost(network: Network) {
                    val activeNet = cm.activeNetwork
                    val caps = activeNet?.let { cm.getNetworkCapabilities(it) }
                    val hasInternet = caps?.hasCapability(
                        NetworkCapabilities.NET_CAPABILITY_INTERNET
                    ) == true
                    if (!hasInternet && isConnected) {
                        isConnected = false
                        sendEvent(false)
                    }
                }
            }

            try {
                cm.registerNetworkCallback(request, cb)
                networkCallback = cb
            } catch (_: SecurityException) {
                // Missing ACCESS_NETWORK_STATE — fallback to always connected
            }
        }
    }

    private fun sendEvent(connected: Boolean) {
        val params = Arguments.createMap().apply {
            putBoolean("isConnected", connected)
        }
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onConnectivityChange", params)
        } catch (_: Exception) {
            // JS runtime not ready yet — ignore
        }
    }

    @ReactMethod
    fun getCurrentStatus(promise: Promise) {
        promise.resolve(isConnected)
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        // Required for RN event emitter
    }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {
        // Required for RN event emitter
    }

    fun onCatalystInstanceDestroy() {
        networkCallback?.let { cb ->
            try {
                connectivityManager?.unregisterNetworkCallback(cb)
            } catch (_: Exception) {
                // ignore
            }
        }
        networkCallback = null
    }
}

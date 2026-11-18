package com.metarouter.reactnative

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class MetaRouterNetworkMonitorModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterNetworkMonitor"

    @Volatile
    private var isConnected: Boolean = true

    /**
     * Whether the default network is wifi; `null` when unknown. Seeded synchronously
     * at construction. `false` with no active network (iOS reports an unsatisfied
     * path the same way); `null` only when the ConnectivityManager is unavailable or
     * the read is refused.
     */
    @Volatile
    private var isWifi: Boolean? = null

    @Volatile private var invalidated = false
    /** Guards [invalidated] + [isWifi] together, so a callback cannot write after invalidate(). */
    private val wifiLock = Any()

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

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
            isWifi = readActiveIsWifi(cm)
        }

        // Register callback for changes
        connectivityManager?.let { cm ->
            val reReadWifi = !startWifiTracking(cm)

            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (reReadWifi) setIsWifi(readActiveIsWifi(cm))
                    if (!isConnected) {
                        isConnected = true
                        sendEvent()
                    }
                }

                override fun onLost(network: Network) {
                    val activeNet = cm.activeNetwork
                    // activeNetwork can still name the network being lost here.
                    if (reReadWifi) {
                        setIsWifi(
                            if (activeNet != null && activeNet != network) readIsWifi(cm, activeNet)
                            else false
                        )
                    }
                    val caps = activeNet?.let { cm.getNetworkCapabilities(it) }
                    val hasInternet = caps?.hasCapability(
                        NetworkCapabilities.NET_CAPABILITY_INTERNET
                    ) == true
                    if (!hasInternet && isConnected) {
                        isConnected = false
                        sendEvent()
                    }
                }

                // Re-read path only: a joining wifi fires onAvailable before it is
                // validated and made the default, so activeNetwork still reads cellular
                // there. Its validation arrives as a capabilities change.
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (reReadWifi) setIsWifi(readActiveIsWifi(cm))
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

    private fun readActiveIsWifi(cm: ConnectivityManager): Boolean? = try {
        val network = cm.activeNetwork
        val caps = network?.let { cm.getNetworkCapabilities(it) }
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ?: false
    } catch (_: Exception) {
        null
    }

    private fun readIsWifi(cm: ConnectivityManager, network: Network): Boolean? = try {
        cm.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ?: false
    } catch (_: Exception) {
        null
    }

    private fun setIsWifi(value: Boolean?) {
        // Check and write under one lock: a callback already in flight when
        // invalidate() ran would otherwise restore the value it cleared.
        synchronized(wifiLock) {
            if (invalidated || isWifi == value) return
            isWifi = value
        }
        // A wifi <-> cellular switch keeps the device connected, so the interface
        // change has to emit on its own or JS keeps stamping the old interface.
        sendEvent()
    }

    /**
     * Tracks the interface of the DEFAULT network — the one the app's traffic uses.
     * The connectivity callback hears every network with INTERNET, so with wifi and
     * cellular both up it cannot say which one is in use. API 24+ has a
     * default-network callback; on 23, or when registering it fails, the connectivity
     * callback re-reads `activeNetwork` instead. Returns whether the default-network
     * callback is in place.
     */
    private fun startWifiTracking(cm: ConnectivityManager): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val cb = object : ConnectivityManager.NetworkCallback() {
            // onCapabilitiesChanged only follows onAvailable reliably from API 26, so
            // on 24-25 a switch can arrive as onAvailable alone.
            override fun onAvailable(network: Network) {
                setIsWifi(readIsWifi(cm, network))
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                setIsWifi(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
            }

            override fun onLost(network: Network) {
                setIsWifi(false)
            }
        }
        return try {
            cm.registerDefaultNetworkCallback(cb)
            wifiCallback = cb
            true
        } catch (_: Exception) {
            // Falls back to re-reading rather than freezing the initial value, which
            // would be the staleness this tracking exists to remove.
            false
        }
    }

    private fun currentState(): WritableMap = Arguments.createMap().apply {
        putBoolean("isConnected", isConnected)
        val wifi = isWifi
        if (wifi == null) putNull("isWifi") else putBoolean("isWifi", wifi)
    }

    private fun sendEvent() {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onConnectivityChange", currentState())
        } catch (_: Exception) {
            // JS runtime not ready yet — ignore
        }
    }

    @ReactMethod
    fun getCurrentStatus(promise: Promise) {
        promise.resolve(currentState())
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        // Required for RN event emitter
    }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {
        // Required for RN event emitter
    }

    override fun invalidate() {
        synchronized(wifiLock) {
            invalidated = true
            isWifi = null
        }
        for (cb in listOfNotNull(networkCallback, wifiCallback)) {
            try {
                connectivityManager?.unregisterNetworkCallback(cb)
            } catch (_: Exception) {
                // ignore
            }
        }
        networkCallback = null
        wifiCallback = null
    }
}

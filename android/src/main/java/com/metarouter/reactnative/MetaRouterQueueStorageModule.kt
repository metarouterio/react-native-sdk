package com.metarouter.reactnative

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import java.io.File

class MetaRouterQueueStorageModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "MetaRouterQueueStorage"

    /**
     * Returns the path to the queue snapshot file.
     * Location: Context.noBackupFilesDir/metarouter/disk-queue/queue.v1.json
     */
    private fun snapshotFile(): File {
        val noBackupDir = reactContext.noBackupFilesDir
        return File(noBackupDir, "metarouter/disk-queue/queue.v1.json")
    }

    @ReactMethod
    fun readSnapshot(promise: Promise) {
        try {
            val file = snapshotFile()
            if (!file.exists()) {
                promise.resolve(null)
                return
            }
            val contents = file.readText(Charsets.UTF_8)
            promise.resolve(contents)
        } catch (e: Exception) {
            promise.reject("READ_ERROR", "Failed to read queue snapshot", e)
        }
    }

    @ReactMethod
    fun writeSnapshot(data: String, promise: Promise) {
        try {
            val file = snapshotFile()
            file.parentFile?.mkdirs()
            file.writeText(data, Charsets.UTF_8)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("WRITE_ERROR", "Failed to write queue snapshot", e)
        }
    }

    @ReactMethod
    fun deleteSnapshot(promise: Promise) {
        try {
            val file = snapshotFile()
            if (file.exists()) {
                file.delete()
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DELETE_ERROR", "Failed to delete queue snapshot", e)
        }
    }
}

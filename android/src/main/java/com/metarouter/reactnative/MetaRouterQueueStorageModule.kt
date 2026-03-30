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

    private fun ensureParentDirectory(file: File) {
        val parent = file.parentFile
            ?: throw IllegalStateException("Snapshot file has no parent directory")

        if (!parent.exists() && !parent.mkdirs()) {
            throw IllegalStateException("Failed to create snapshot directory")
        }

        if (!parent.isDirectory) {
            throw IllegalStateException("Snapshot parent path is not a directory")
        }
    }

    private fun deleteIfExists(file: File, errorMessage: String) {
        if (file.exists() && !file.delete()) {
            throw IllegalStateException(errorMessage)
        }
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
            ensureParentDirectory(file)

            val parent = file.parentFile
                ?: throw IllegalStateException("Snapshot file has no parent directory")
            val tempFile = File(parent, "${file.name}.tmp")
            val backupFile = File(parent, "${file.name}.bak")

            deleteIfExists(tempFile, "Failed to clear stale temp snapshot")
            tempFile.writeText(data, Charsets.UTF_8)

            val hadExistingSnapshot = file.exists()
            if (hadExistingSnapshot) {
                deleteIfExists(backupFile, "Failed to clear stale backup snapshot")
                if (!file.renameTo(backupFile)) {
                    deleteIfExists(tempFile, "Failed to clean up temp snapshot")
                    throw IllegalStateException("Failed to back up existing snapshot")
                }
            }

            if (!tempFile.renameTo(file)) {
                deleteIfExists(tempFile, "Failed to clean up temp snapshot")

                if (hadExistingSnapshot && backupFile.exists() && !backupFile.renameTo(file)) {
                    throw IllegalStateException(
                        "Failed to write queue snapshot and restore previous snapshot"
                    )
                }

                throw IllegalStateException("Failed to move temp snapshot into place")
            }

            deleteIfExists(backupFile, "Failed to delete snapshot backup")
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("WRITE_ERROR", "Failed to write queue snapshot", e)
        }
    }

    @ReactMethod
    fun deleteSnapshot(promise: Promise) {
        try {
            val file = snapshotFile()
            deleteIfExists(file, "Failed to delete queue snapshot")
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DELETE_ERROR", "Failed to delete queue snapshot", e)
        }
    }
}

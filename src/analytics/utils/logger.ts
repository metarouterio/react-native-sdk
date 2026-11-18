/**
 * Simple logger utility for MetaRouter SDK.
 *
 * - Allows toggling debug logging for development and troubleshooting.
 * - Always logs warnings and errors, regardless of debug setting.
 * - Prepends all logs with a [MetaRouter] tag for easy identification.
 */

let enabled = false;

/**
 * Enables or disables debug logging.
 * @param value If true, enables debug logging; if false, disables it.
 */
export function setDebugLogging(value: boolean) {
  enabled = value;
}

/**
 * Logs a message to the console if debug logging is enabled.
 * @param args Arguments to log.
 */
export function log(...args: any[]) {
  if (!enabled) return;
  try {
    console.log('[MetaRouter]', ...args);
  } catch {
    // As warn.
  }
}

/**
 * Logs a warning to the console (always, regardless of debug setting).
 * @param args Arguments to log as a warning.
 */
export function warn(...args: any[]) {
  try {
    console.warn('[MetaRouter]', ...args);
  } catch {
    // Logging must never change SDK control flow: hosts sometimes make
    // console.warn throw (fail-on-console test setups), and a warning can sit
    // on the import path. Such a host no longer sees SDK warnings as thrown
    // test failures; setups that record calls and fail afterwards still do.
  }
}

/**
 * Logs an error to the console (always, regardless of debug setting).
 * @param args Arguments to log as an error.
 */
export function error(...args: any[]) {
  try {
    console.error('[MetaRouter]', ...args);
  } catch {
    // As warn.
  }
}

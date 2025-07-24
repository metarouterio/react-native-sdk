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
  if (enabled) console.log('[MetaRouter]', ...args);
}

/**
 * Logs a warning to the console (always, regardless of debug setting).
 * @param args Arguments to log as a warning.
 */
export function warn(...args: any[]) {
  console.warn('[MetaRouter]', ...args);
}

/**
 * Logs an error to the console (always, regardless of debug setting).
 * @param args Arguments to log as an error.
 */
export function error(...args: any[]) {
  console.error('[MetaRouter]', ...args);
}
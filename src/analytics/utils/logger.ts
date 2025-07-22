let enabled = false;

export function setDebugLogging(value: boolean) {
  enabled = value;
}

export function log(...args: any[]) {
  if (enabled) console.log('[MetaRouter]', ...args);
}

export function warn(...args: any[]) {
  // Always log warnings, even when debug is disabled
  console.warn('[MetaRouter]', ...args);
}

export function error(...args: any[]) {
  // Always log errors, even when debug is disabled
  console.error('[MetaRouter]', ...args);
}
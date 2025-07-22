let enabled = false;

export function setDebugLogging(value: boolean) {
  enabled = value;
}

export function log(...args: any[]) {
  if (enabled) console.log('[MetaRouter]', ...args);
}

export function warn(...args: any[]) {
  if (enabled) console.warn('[MetaRouter]', ...args);
}
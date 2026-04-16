/**
 * Shared classification of HTTP status codes used by both
 * the dispatcher and the overflow disk drain.
 */
export enum ResponseCategory {
  SUCCESS = 'SUCCESS',
  SERVER_ERROR = 'SERVER_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  FATAL_CONFIG = 'FATAL_CONFIG',
  CLIENT_ERROR = 'CLIENT_ERROR',
}

export function categorizeResponse(statusCode: number): ResponseCategory {
  if (statusCode >= 200 && statusCode < 300) return ResponseCategory.SUCCESS;
  if (statusCode >= 500 || statusCode === 408)
    return ResponseCategory.SERVER_ERROR;
  if (statusCode === 429) return ResponseCategory.RATE_LIMITED;
  if (statusCode === 413) return ResponseCategory.PAYLOAD_TOO_LARGE;
  if (statusCode === 401 || statusCode === 403 || statusCode === 404)
    return ResponseCategory.FATAL_CONFIG;
  return ResponseCategory.CLIENT_ERROR;
}

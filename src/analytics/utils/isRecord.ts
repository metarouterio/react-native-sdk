/** A plain (non-array, non-null) object, as JSON-shaped input is checked. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

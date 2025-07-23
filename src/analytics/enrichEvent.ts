import {   EnrichedEventPayload, EventWithIdentity } from "./types";
import { getContextInfo } from "./utils/contextInfo";


export function enrichEvent(
  event: EventWithIdentity,
  writeKey: string
): EnrichedEventPayload {
  const enriched = {
    ...event,
    writeKey,
    messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sentAt: new Date().toISOString(),
    context: getContextInfo(),
  };

  return enriched;
}
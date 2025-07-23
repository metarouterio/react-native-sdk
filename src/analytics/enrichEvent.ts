import {   EnrichedEventPayload, EventContext, EventWithIdentity } from "./types";


export function enrichEvent(
  event: EventWithIdentity,
  writeKey: string,
  context: EventContext
): EnrichedEventPayload {
  const enriched = {
    ...event,
    writeKey,
    messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sentAt: new Date().toISOString(),
    context,
  };

  return enriched;
}
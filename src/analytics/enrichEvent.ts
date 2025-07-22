import { EnrichedEventPayload, EventPayload } from "./types";
import { getContextInfo } from "./utils/contextInfo";
import { v4 as uuidv4 } from 'uuid';

export function enrichEvent(
  event: EventPayload,
  anonymousId: string,
  writeKey: string
): EnrichedEventPayload {
  const enriched: EnrichedEventPayload = {
    ...event,
    anonymousId,
    writeKey,
    messageId: `${Date.now()}-${crypto.randomUUID()}`,
    sentAt: new Date().toISOString(),
    timestamp: event.timestamp ?? new Date().toISOString(),
    context: getContextInfo(),
  };

  return enriched;
}
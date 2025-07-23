import {   EnrichedEventPayload, EventWithIdentity } from "./types";
import { getContextInfo } from "./utils/contextInfo";
import { v4 as uuidv4 } from 'uuid';

export function enrichEvent(
  event: EventWithIdentity,
  writeKey: string
): EnrichedEventPayload {
  const enriched = {
    ...event,
    writeKey,
    anonymousId: uuidv4(),
    messageId: uuidv4(),  
    sentAt: new Date().toISOString(),
    context: getContextInfo(),
  };

  return enriched;
}
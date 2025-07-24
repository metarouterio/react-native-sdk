import {   EnrichedEventPayload, EventContext, EventWithIdentity } from "../types";

/**
 * Enriches an analytics event with additional metadata required for ingestion.
 *
 * - Adds a unique messageId and the current sentAt timestamp.
 * - Injects the provided writeKey and context information into the event.
 * - Returns a new EnrichedEventPayload object, suitable for sending to the ingestion endpoint.
 *
 * @param event   The base event with identity information.
 * @param writeKey The write key for the analytics project.
 * @param context  The context information (device, app, environment, etc.).
 * @returns        The enriched event payload.
 */
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
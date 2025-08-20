import {
  EnrichedEventPayload,
  EventContext,
  EventWithIdentity,
} from "../types";
import uuid from "react-native-uuid";

/**
 * Generate a messageId with a timestamp prefix (ms since epoch + UUID).
 * This makes it easy to debug when events were created.
 */
function generateMessageId(): string {
  const ts = Date.now(); // ms since epoch
  return `${ts}-${uuid.v4()}`;
}

/**
 * Enriches an analytics event with additional metadata required for ingestion.
 *
 * - Adds a unique messageId and the current sentAt timestamp.
 * - Injects the provided writeKey and context information into the event.
 * - Returns a new EnrichedEventPayload object, suitable for sending to the ingestion endpoint.
 *
 * @param event    The base event with identity information.
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
    messageId: generateMessageId(),
    context,
  };

  return enriched;
}

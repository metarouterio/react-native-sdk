import { log, warn } from '../utils/logger';
import { BridgeDedupStore } from './bridgeDedupStore';
import {
  parseBridgeEnvelope,
  type BridgeEnvelope,
  type BridgeErrorCode,
} from './bridgeEnvelope';

/**
 * Ack / error reply sent back to the wrapper. Wire shape (absent fields are
 * omitted, as on iOS and Android):
 * - ok:    `{"status":"ok","messageId":"…"}`
 * - error: `{"status":"error","messageId":"…","code":"…","message":"…","supportedVersion":1}`
 */
export interface BridgeReply {
  status: 'ok' | 'error';
  messageId?: string;
  code?: BridgeErrorCode;
  message?: string;
  supportedVersion?: number;
}

/**
 * Receives validated, deduplicated envelopes. Returns whether the event
 * actually entered the delivery path: an `ok` ack for an event that was
 * silently dropped (SDK not ready) would lie to the producer.
 */
export type BridgeEventSink = (envelope: BridgeEnvelope) => boolean;

/**
 * The receive pipeline: raw message → parse/validate → dedup → sink, producing
 * the reply for the wrapper. One processor serves every attached WebView of a
 * session, like the native SDKs' one processor per client.
 *
 * Rejections are logged as well as replied — page consoles are rarely watched
 * in production, so the app log is the primary debugging surface. JS is
 * single-threaded, so the native "one confined thread" rule holds by
 * construction.
 */
export class BridgeMessageProcessor {
  constructor(
    private readonly sink: BridgeEventSink,
    private readonly dedupStore: BridgeDedupStore = new BridgeDedupStore()
  ) {}

  process(raw: string): BridgeReply {
    const result = parseBridgeEnvelope(raw);
    if (!result.valid) {
      // Truncated: for unknown_type the message embeds page-controlled text,
      // and a page could otherwise write 64 KB lines into the app log.
      warn(
        `WebView bridge message rejected (${result.code}): ${result.message.slice(0, 200)}`
      );
      // Key order matches the native serializers, so the wire form is
      // byte-identical across platforms.
      return {
        status: 'error',
        ...(result.messageId !== undefined && { messageId: result.messageId }),
        code: result.code,
        message: result.message,
        ...(result.supportedVersion !== undefined && {
          supportedVersion: result.supportedVersion,
        }),
      };
    }

    const { envelope } = result;
    if (!this.dedupStore.markIfNew(envelope.messageId)) {
      // Acked ok, not errored: the producer's goal — exactly-once enqueue —
      // was already met by the first delivery.
      log(`WebView bridge duplicate dropped (messageId=${envelope.messageId})`);
      return { status: 'ok', messageId: envelope.messageId };
    }
    let accepted = false;
    try {
      accepted = this.sink(envelope);
    } catch (err) {
      warn('WebView bridge event enqueue failed:', err);
    }
    if (accepted) {
      return { status: 'ok', messageId: envelope.messageId };
    }
    // Never entered the delivery path — un-record the id so a producer retry
    // is not misread as a duplicate of a message that was in fact lost.
    this.dedupStore.forget(envelope.messageId);
    // Debug-level, as on iOS: expected while the SDK initializes or resets,
    // and a page retrying in a loop must not flood the app log.
    log(`WebView bridge event not accepted (messageId=${envelope.messageId})`);
    return {
      status: 'error',
      messageId: envelope.messageId,
      code: 'not_ready',
      message: 'SDK not ready to accept events',
    };
  }
}

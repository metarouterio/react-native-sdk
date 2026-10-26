import { BridgeDedupStore } from './bridgeDedupStore';
import { BridgeMessageProcessor } from './bridgeMessageProcessor';
import type { BridgeEnvelope } from './bridgeEnvelope';

const envelope = (messageId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    messageId,
    type: 'track',
    name: 'e',
    properties: { a: 1 },
    ...extra,
  });

describe('BridgeMessageProcessor', () => {
  let received: BridgeEnvelope[];
  let accept: boolean;
  let processor: BridgeMessageProcessor;

  beforeEach(() => {
    received = [];
    accept = true;
    let now = 0;
    processor = new BridgeMessageProcessor(
      (e) => {
        received.push(e);
        return accept;
      },
      new BridgeDedupStore(100, 60_000, () => now++)
    );
  });

  it('enqueues a valid envelope and acks ok', () => {
    expect(processor.process(envelope('m1'))).toEqual({
      status: 'ok',
      messageId: 'm1',
    });
    expect(received).toHaveLength(1);
  });

  it('hands the sink the parsed envelope, not the raw string', () => {
    processor.process(envelope('m1'));
    expect(received[0]).toMatchObject({
      messageId: 'm1',
      properties: { a: 1 },
    });
  });

  it('rejects an invalid envelope with its specific code and never reaches the sink', () => {
    expect(processor.process(envelope('m1', { version: 2 }))).toEqual({
      status: 'error',
      messageId: 'm1',
      code: 'unsupported_version',
      message: 'envelope version 2 > supported 1',
      supportedVersion: 1,
    });
    expect(processor.process('{')).toEqual({
      status: 'error',
      code: 'malformed_json',
      message: 'envelope is not valid JSON',
    });
    expect(received).toHaveLength(0);
  });

  it('drops a duplicate messageId but still acks it ok', () => {
    processor.process(envelope('m1'));
    expect(processor.process(envelope('m1'))).toEqual({
      status: 'ok',
      messageId: 'm1',
    });
    expect(received).toHaveLength(1);
  });

  it('enqueues distinct messageIds', () => {
    processor.process(envelope('m1'));
    processor.process(envelope('m2'));
    expect(received.map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });

  it('does not let a rejected message poison the dedup store', () => {
    processor.process(envelope('m1', { properties: 'bad' }));
    processor.process(envelope('m1'));
    expect(received).toHaveLength(1);
  });

  it('NAKs not_ready when the sink refuses, and lets the retry through', () => {
    accept = false;
    expect(processor.process(envelope('m1'))).toEqual({
      status: 'error',
      messageId: 'm1',
      code: 'not_ready',
      message: 'SDK not ready to accept events',
    });
    accept = true;
    expect(processor.process(envelope('m1')).status).toBe('ok');
    expect(received).toHaveLength(2);
  });

  it('truncates page-controlled text in the rejection log to 200 chars', () => {
    const warnSpy = jest.spyOn(require('../utils/logger'), 'warn');
    processor.process(envelope('m1', { type: 'x'.repeat(10_000) }));
    const line = warnSpy.mock.calls[0]![0] as string;
    expect(line.length).toBeLessThan(300);
    warnSpy.mockRestore();
  });

  it('logs not_ready at debug level, not as a warning', () => {
    const warnSpy = jest.spyOn(require('../utils/logger'), 'warn');
    accept = false;
    processor.process(envelope('m1'));
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('serializes replies with the native key order', () => {
    expect(
      JSON.stringify(processor.process(envelope('m1', { version: 2 })))
    ).toBe(
      '{"status":"error","messageId":"m1","code":"unsupported_version","message":"envelope version 2 > supported 1","supportedVersion":1}'
    );
  });

  it('NAKs not_ready instead of throwing when the sink throws', () => {
    const throwing = new BridgeMessageProcessor(() => {
      throw new Error('boom');
    });
    expect(throwing.process(envelope('m1')).code).toBe('not_ready');
  });
});

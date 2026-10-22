import {
  MAX_ENVELOPE_BYTES,
  MAX_MESSAGE_ID_CHARS,
  parseBridgeEnvelope,
  type BridgeParseResult,
} from './bridgeEnvelope';

const base = {
  version: 1,
  messageId: '5f0c3b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  type: 'track',
  name: 'flight_search',
  properties: { origin: 'DXB' },
  sentAt: '2026-07-09T14:03:22.114Z',
  page: {
    url: 'https://www.example.com/booking?x=1',
    path: '/booking',
    search: '?x=1',
    title: 'Book a flight',
    referrer: '',
  },
  source: { producer: 'wrapper', wrapperVersion: '1.0.0' },
};

const omit = (key: keyof typeof base) => {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return copy;
};

const parse = (value: unknown) =>
  parseBridgeEnvelope(
    typeof value === 'string' ? value : JSON.stringify(value)
  );

function expectInvalid(
  result: BridgeParseResult,
  code: string,
  messageId?: string
) {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.code).toBe(code);
  expect(result.messageId).toBe(messageId);
}

describe('parseBridgeEnvelope', () => {
  it('parses a valid track envelope with all fields', () => {
    const result = parse(base);
    expect(result).toEqual({ valid: true, envelope: base });
  });

  it('parses a page envelope', () => {
    const result = parse({ ...base, type: 'page' });
    expect(result.valid && result.envelope.type).toBe('page');
  });

  it('parses a minimal envelope with only required fields', () => {
    const result = parse({
      version: 1,
      messageId: 'm1',
      type: 'track',
      name: 'e',
    });
    expect(result).toEqual({
      valid: true,
      envelope: {
        version: 1,
        messageId: 'm1',
        type: 'track',
        name: 'e',
        properties: {},
      },
    });
  });

  it('ignores unknown fields (forward compatibility)', () => {
    const result = parse({ ...base, futureField: { a: 1 } });
    expect(result.valid).toBe(true);
    expect(result.valid && 'futureField' in result.envelope).toBe(false);
  });

  it('treats optional fields of the wrong type as absent', () => {
    const result = parse({
      ...base,
      sentAt: 123,
      page: 'nope',
      source: [],
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.envelope.sentAt).toBeUndefined();
    expect(result.envelope.page).toBeUndefined();
    expect(result.envelope.source).toBeUndefined();
  });

  it('rejects invalid JSON with malformed_json and no messageId', () => {
    expectInvalid(parse('{not json'), 'malformed_json');
  });

  it.each([['[]'], ['"str"'], ['42'], ['null']])(
    'rejects non-object JSON %s with malformed_payload',
    (raw) => {
      expectInvalid(parse(raw), 'malformed_payload');
    }
  );

  it('rejects non-object properties with malformed_payload, echoing messageId', () => {
    expectInvalid(
      parse({ ...base, properties: 'oops' }),
      'malformed_payload',
      base.messageId
    );
    expectInvalid(
      parse({ ...base, properties: [1] }),
      'malformed_payload',
      base.messageId
    );
  });

  it.each([[1.5], ['1'], [true]])(
    'rejects a non-integer version %p with malformed_payload',
    (version) => {
      expectInvalid(
        parse({ ...base, version }),
        'malformed_payload',
        base.messageId
      );
    }
  );

  it('rejects a version below 1', () => {
    expectInvalid(
      parse({ ...base, version: 0 }),
      'malformed_payload',
      base.messageId
    );
  });

  it('rejects a missing or blank messageId with missing_field', () => {
    expectInvalid(parse(omit('messageId')), 'missing_field');
    expectInvalid(parse({ ...base, messageId: '   ' }), 'missing_field');
  });

  it('rejects an oversized messageId without echoing it back', () => {
    const result = parse({
      ...base,
      messageId: 'x'.repeat(MAX_MESSAGE_ID_CHARS + 1),
    });
    expectInvalid(result, 'malformed_payload');
  });

  it('accepts a messageId at exactly the cap', () => {
    const messageId = 'x'.repeat(MAX_MESSAGE_ID_CHARS);
    const result = parse({ ...base, messageId });
    expect(result.valid && result.envelope.messageId).toBe(messageId);
  });

  it('rejects a missing version with missing_field, echoing messageId', () => {
    expectInvalid(parse(omit('version')), 'missing_field', base.messageId);
  });

  it('rejects a missing type, and a missing or empty name, with missing_field', () => {
    expectInvalid(parse(omit('type')), 'missing_field', base.messageId);
    expectInvalid(parse(omit('name')), 'missing_field', base.messageId);
    expectInvalid(
      parse({ ...base, name: '' }),
      'missing_field',
      base.messageId
    );
  });

  it.each([['identify'], ['screen']])(
    'rejects type %s with unknown_type in contract v1',
    (type) => {
      expectInvalid(parse({ ...base, type }), 'unknown_type', base.messageId);
    }
  );

  it('rejects a newer version with unsupported_version and supportedVersion', () => {
    const result = parse({ ...base, version: 2 });
    expect(result).toEqual({
      valid: false,
      code: 'unsupported_version',
      message: 'envelope version 2 > supported 1',
      messageId: base.messageId,
      supportedVersion: 1,
    });
  });

  it('rejects an envelope over 64 KB with payload_too_large', () => {
    const raw = JSON.stringify({
      ...base,
      properties: { blob: 'a'.repeat(MAX_ENVELOPE_BYTES) },
    });
    expectInvalid(parseBridgeEnvelope(raw), 'payload_too_large');
  });

  it('measures the size limit in UTF-8 bytes, not chars', () => {
    // 'é' is one UTF-16 unit but two UTF-8 bytes: under the cap in chars,
    // over it in bytes.
    const filler = 'é'.repeat(MAX_ENVELOPE_BYTES / 2);
    const raw = JSON.stringify({ ...base, properties: { filler } });
    expect(raw.length).toBeLessThan(MAX_ENVELOPE_BYTES);
    expectInvalid(parseBridgeEnvelope(raw), 'payload_too_large');
  });

  it('counts a surrogate pair as four bytes', () => {
    // '😀' is two UTF-16 units and four UTF-8 bytes; just under the cap.
    const overhead = JSON.stringify({ ...base, properties: { e: '' } }).length;
    const pairs = Math.floor((MAX_ENVELOPE_BYTES - overhead) / 4);
    const raw = JSON.stringify({
      ...base,
      properties: { e: '😀'.repeat(pairs) },
    });
    expect(parseBridgeEnvelope(raw).valid).toBe(true);
    const over = JSON.stringify({
      ...base,
      properties: { e: '😀'.repeat(pairs + 1) },
    });
    expectInvalid(parseBridgeEnvelope(over), 'payload_too_large');
  });
});

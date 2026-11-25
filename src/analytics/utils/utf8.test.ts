import { utf8ByteLength } from './utf8';

describe('utf8ByteLength', () => {
  const encoder = new TextEncoder();
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['ASCII', '{"event":"Purchase","price":9.99}'],
    ['2-byte (Latin-1, Arabic)', 'café مرحبا'],
    ['3-byte (CJK)', '購入完了'],
    ['4-byte (emoji, surrogate pairs)', '🛒👍🏽'],
    ['lone high surrogate', 'a\ud83db'],
    ['lone high surrogate at end', 'a\ud83d'],
    ['lone low surrogate', 'a\ude00b'],
    ['reversed pair', '\ude00\ud83d'],
    ['boundaries', '\u007f\u0080߿ࠀ￿'],
  ];

  it.each(cases)('matches TextEncoder: %s', (_, str) => {
    expect(utf8ByteLength(str)).toBe(encoder.encode(str).byteLength);
  });
});

describe('without TextEncoder (Hermes before React Native 0.74)', () => {
  const original = global.TextEncoder;

  afterEach(() => {
    global.TextEncoder = original;
  });

  it('the SDK still loads', () => {
    // @ts-expect-error simulating an engine without the global
    delete global.TextEncoder;
    jest.isolateModules(() => {
      expect(() => require('../../index')).not.toThrow();
    });
  });
});

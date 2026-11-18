import { OneTrustAdapter, percentDecoded } from './oneTrustAdapter';
import { ConsentManager } from '../consentManager';

const normalize = OneTrustAdapter.normalize;

describe('OneTrustAdapter', () => {
  describe('statuses', () => {
    it('inverts opt-in to opt-out and lowercases keys', () => {
      expect(normalize({ 'C0001': 1, ' C0002 ': 0 }, true)).toEqual({
        explicit: true,
        optOut: { c0001: false, c0002: true },
      });
    });

    it('reads booleans, numbers and strings; anything else counts as opted out', () => {
      const out = normalize(
        {
          a: true,
          b: 1,
          c: '1',
          d: ' TRUE ',
          e: false,
          f: 0,
          g: '0',
          h: 1.5,
          i: null,
          j: {},
          k: 'yes',
        },
        false
      );
      expect(out.optOut).toEqual({
        a: false,
        b: false,
        c: false,
        d: false,
        e: true,
        f: true,
        g: true,
        h: true,
        i: true,
        j: true,
        k: true,
      });
    });

    it('keys colliding after lowercasing resolve opted out; no timestamp is set', () => {
      const out = normalize({ C0004: 1, c0004: 0 }, true);
      expect(out.optOut).toEqual({ c0004: true });
      expect(out).not.toHaveProperty('timestamp');
    });
  });

  describe('groups', () => {
    it.each([
      ['a bare list', 'C0001:1,C0002:0'],
      ['whitespace and malformed segments', ' C0001 : 1 , junk, :1, C0002:0,'],
      ['percent-encoded', 'C0001%3A1%2CC0002%3A0'],
      [
        'the whole OptanonConsent value',
        'isGpcEnabled=0&datestamp=Mon&groups=C0001%3A1%2CC0002%3A0&hosts=H1%3A1',
      ],
      [
        'a cookie jar with a stray % and groups last',
        'other=50%off; OptanonConsent=isGpcEnabled=0&groups=C0001%3A1%2CC0002%3A0; next=1',
      ],
      [
        'groups first in a cookie of a jar',
        'a=1; OptanonConsent=groups=C0001%3A1%2CC0002%3A0',
      ],
      [
        'an unrelated groups cookie first',
        'groups=admins; OptanonConsent=groups=C0001:1,C0002:0',
      ],
      ['a whole value encoded twice', 'groups%3DC0001%253A1%252CC0002%253A0'],
    ])('parses %s', (_, input) => {
      expect(normalize(input, true).optOut).toEqual({
        c0001: false,
        c0002: true,
      });
    });

    it('ignores encoded delimiters inside other parameters', () => {
      const out = normalize(
        'hosts=H1%3A1%26groups%3DC9%3A1&groups=C0001%3A0',
        true
      );
      expect(out.optOut).toEqual({ c0001: true });
    });

    it('drops name-prefixed segments and never parses other parameters whole', () => {
      expect(normalize('foo=C0001:1,C0002:0', true).optOut).toEqual({
        c0002: true,
      });
      expect(normalize('isGpcEnabled=0&hosts=H1:1,H2:0', true).optOut).toEqual(
        {}
      );
    });

    it('empty input yields an empty optOut', () => {
      expect(normalize('', true).optOut).toEqual({});
      expect(normalize('a=1&groups=', true).optOut).toEqual({});
    });

    it('decodes invalid UTF-8 bytes to U+FFFD and keeps parsing, as Android does', () => {
      expect(normalize('a=1&groups=C0001%3A1%2CX%E9%3A0', true).optOut).toEqual(
        { 'c0001': false, 'x\ufffd': true }
      );
    });

    // Expected values are java.net.URLDecoder.decode(input, "UTF-8") output on
    // a HotSpot JVM. Android's runtime decoder may split an encoded surrogate
    // (ED A0 80) into three U+FFFD; unreachable for OneTrust's ASCII IDs.
    it.each([
      ['C%E2%82%41', 'C\ufffdA'],
      ['X%E9%3A0', 'X\ufffd:0'],
      ['%F0%9F%98', '\ufffd'],
      ['%ED%A0%80', '\ufffd'],
      ['%C0%AF', '\ufffd\ufffd'],
      ['%F4%90%80%80', '\ufffd\ufffd\ufffd\ufffd'],
      ['%E2%82%AC', '\u20ac'],
    ])('decodes %s as Java does', (input, expected) => {
      expect(percentDecoded(input)).toBe(expected);
    });

    it('keeps the raw value on a malformed escape', () => {
      expect(normalize('C0001:1,C%G2:0', true).optOut).toEqual({
        'c0001': false,
        'c%g2': true,
      });
    });

    it('does not decode + as a space', () => {
      expect(normalize('C+1:1', true).optOut).toEqual({ 'c+1': false });
    });

    it('mixed-case collisions resolve opted out and round-trip through setConsent', async () => {
      const manager = new ConsentManager({
        load: async () => null,
        save: async () => {},
      });
      await manager.load();
      manager.registerConsentCategories([
        { key: 'c0004', defaultOptOut: false },
      ]);
      expect(manager.setConsent(normalize('C0004:1,c0004:0', true))).toBe(true);
      expect(manager.getConsent().optOut).toEqual({ c0004: true });
    });
  });
});

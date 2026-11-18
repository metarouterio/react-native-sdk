/**
 * Byte length of `str` encoded as UTF-8, counted without encoding it. Sizes
 * queued events and bridge payloads.
 *
 * Not `TextEncoder`: Hermes only has it from React Native 0.74, and the peer
 * range starts at 0.73, where constructing one throws on import. Counts match
 * `TextEncoder` exactly, including a lone surrogate as 3 bytes (it encodes the
 * U+FFFD replacement character).
 */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair is one code point above U+FFFF: 4 bytes.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      // BMP above U+07FF, and a lone low surrogate (U+FFFD): 3 bytes.
      bytes += 3;
    }
  }
  return bytes;
}

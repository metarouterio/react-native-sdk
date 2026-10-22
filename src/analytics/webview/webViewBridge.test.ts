import { BridgeMessageProcessor } from './bridgeMessageProcessor';
import { BRIDGE_MESSAGE_PREFIX } from './bridgeWrapperScript';
import {
  attachWebViewBridge,
  bridgeMessagePrefixFor,
  originOf,
} from './webViewBridge';
import type { BridgeEnvelope } from './bridgeEnvelope';

const ORIGIN = 'https://shop.example.com';

const message = (data: string, url: string = `${ORIGIN}/cart`) => ({
  nativeEvent: { data, url },
});

let prefix = BRIDGE_MESSAGE_PREFIX;
const bridgeMessage = (messageId: string, url?: string) =>
  message(
    prefix +
      JSON.stringify({ version: 1, messageId, type: 'track', name: 'E' }),
    url
  );

describe('attachWebViewBridge', () => {
  let received: BridgeEnvelope[];
  let processor: BridgeMessageProcessor;
  let injected: string[];
  let ref: { current: { injectJavaScript: (s: string) => void } | null };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    received = [];
    processor = new BridgeMessageProcessor((e) => {
      received.push(e);
      return true;
    });
    prefix = bridgeMessagePrefixFor(processor);
    injected = [];
    ref = { current: { injectJavaScript: (s) => injected.push(s) } };
    warnSpy = jest.spyOn(require('../utils/logger'), 'warn');
  });

  afterEach(() => warnSpy.mockRestore());

  it('returns the wrapper and a handler for valid origins', () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toContain(
      JSON.stringify([ORIGIN])
    );
  });

  it.each([
    [[] as string[], 'no allowed origins'],
    [['*'], 'invalid origin rules'],
    [['https://shop.example.com/'], 'invalid origin rules'],
    [['https://shop.example.com/path'], 'invalid origin rules'],
    [['shop.example.com'], 'invalid origin rules'],
  ])('refuses %p with a warning and inert props', (origins, text) => {
    const bridge = attachWebViewBridge(ref, origins, processor);
    // Empty, not undefined: safe to join with a host script.
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toBe('');
    // Still claimed: a page loaded under an earlier valid attach keeps posting,
    // and its envelopes must not reach the host's handler.
    expect(bridge.onMessage(bridgeMessage('m1'))).toBe(true);
    expect(bridge.onMessage(message('host message'))).toBe(false);
    expect(received).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(text));
  });

  it('normalizes case and default ports before validating', () => {
    const bridge = attachWebViewBridge(
      ref,
      ['HTTPS://Shop.Example.com:443'],
      processor
    );
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toContain(
      JSON.stringify([ORIGIN])
    );
    expect(bridge.onMessage(bridgeMessage('m1'))).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('accepts bracketed IPv6 loopback without a cleartext warning', () => {
    const bridge = attachWebViewBridge(ref, ['http://[::1]:3000'], processor);
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns on cleartext non-loopback origins but still attaches', () => {
    const bridge = attachWebViewBridge(
      ref,
      ['http://shop.example.com'],
      processor
    );
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cleartext'));
  });

  it('routes a bridge message through the processor and replies over the ref', () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);

    expect(bridge.onMessage(bridgeMessage('m1'))).toBe(true);

    expect(received.map((e) => e.messageId)).toEqual(['m1']);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(
      JSON.stringify(JSON.stringify({ status: 'ok', messageId: 'm1' }))
    );
  });

  it('replies with the error for an invalid message and never enqueues it', () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    bridge.onMessage(message(prefix + '{'));
    expect(received).toHaveLength(0);
    expect(injected[0]).toContain('malformed_json');
  });

  it("passes the host's own messages through untouched", () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    expect(bridge.onMessage(message('{"type":"host-event"}'))).toBe(false);
    expect(bridge.onMessage({ nativeEvent: { data: undefined as any } })).toBe(
      false
    );
    expect(received).toHaveLength(0);
    expect(injected).toHaveLength(0);
  });

  it('drops a bridge message from a non-allowlisted frame without a reply', () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    // An iframe from another origin posting a well-formed bridge message.
    expect(
      bridge.onMessage(bridgeMessage('m1', 'https://ads.example.net/frame'))
    ).toBe(true);
    expect(bridge.onMessage(bridgeMessage('m2', 'about:blank'))).toBe(true);
    expect(received).toHaveLength(0);
    expect(injected).toHaveLength(0);
  });

  it('embeds the session token in the wrapper and keeps it stable across renders', () => {
    const first = attachWebViewBridge(ref, [ORIGIN], processor);
    const second = attachWebViewBridge(ref, [ORIGIN], processor);
    expect(first.injectedJavaScriptBeforeContentLoaded).toContain(
      JSON.stringify(prefix)
    );
    expect(second.injectedJavaScriptBeforeContentLoaded).toBe(
      first.injectedJavaScriptBeforeContentLoaded
    );
    expect(prefix).toMatch(/^__metaRouterBridge:[0-9a-f-]{36}:$/);
  });

  it('drops a bridge-shaped message without the session token, even from an allowlisted URL', () => {
    // Android without WEB_MESSAGE_LISTENER reports the main page's URL for a
    // message posted by any frame, so a cross-origin iframe passes the origin
    // check; only the token tells it apart.
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    const forged = message(
      BRIDGE_MESSAGE_PREFIX +
        JSON.stringify({
          version: 1,
          messageId: 'f1',
          type: 'track',
          name: 'E',
        })
    );
    expect(bridge.onMessage(forged)).toBe(true);
    const otherSession = message(
      `${BRIDGE_MESSAGE_PREFIX}00000000-0000-4000-8000-000000000000:{}`
    );
    expect(bridge.onMessage(otherSession)).toBe(true);
    expect(received).toHaveLength(0);
    expect(injected).toHaveLength(0);
  });

  it('warns about a refused origin list once, not on every render', () => {
    attachWebViewBridge(ref, ['https://repeat.example.com/'], processor);
    attachWebViewBridge(ref, ['https://repeat.example.com/'], processor);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('guards the reply script with the allowlist', () => {
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    bridge.onMessage(bridgeMessage('m1'));
    expect(injected[0]).toContain(
      `${JSON.stringify([ORIGIN])}.indexOf(location.origin) !== -1`
    );
  });

  it.each([
    ['a BigInt', [1n as unknown as string]],
    [
      'a cyclic object',
      [
        (() => {
          const o: any = {};
          o.o = o;
          return o;
        })(),
      ],
    ],
    ['a non-string', [42 as unknown as string]],
    ['not an array', 'https://shop.example.com' as unknown as string[]],
  ])('refuses %s without throwing', (_label, origins) => {
    expect(() => attachWebViewBridge(ref, origins, processor)).not.toThrow();
    expect(
      attachWebViewBridge(ref, origins, processor)
        .injectedJavaScriptBeforeContentLoaded
    ).toBe('');
  });

  it('bounds the cache of built attachments', () => {
    for (let i = 0; i < 20; i++) {
      attachWebViewBridge(ref, [`https://h${i}.example.com`], processor);
    }
    // The earliest list was evicted and rebuilds — still working, same token.
    const again = attachWebViewBridge(
      ref,
      ['https://h0.example.com'],
      processor
    );
    expect(again.injectedJavaScriptBeforeContentLoaded).toContain(
      JSON.stringify(prefix)
    );
  });

  it('evicts the least recently rendered list, not the oldest inserted', () => {
    const logSpy = jest.spyOn(require('../utils/logger'), 'log');
    const lists = Array.from({ length: 8 }, (_, i) => [
      `https://lru${i}.example.com`,
    ]);
    for (const l of lists) attachWebViewBridge(ref, l, processor);
    attachWebViewBridge(ref, lists[0]!, processor); // touched: now most recent
    attachWebViewBridge(ref, ['https://lru-new.example.com'], processor); // evicts lru1
    logSpy.mockClear();
    attachWebViewBridge(ref, lists[0]!, processor);
    expect(logSpy).not.toHaveBeenCalled(); // still cached
    attachWebViewBridge(ref, lists[1]!, processor);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('attached')); // rebuilt
    logSpy.mockRestore();
  });

  it('logs the missing ref once, not once per render', () => {
    const logSpy = jest.spyOn(require('../utils/logger'), 'log');
    for (let i = 0; i < 3; i++) {
      attachWebViewBridge(null, [ORIGIN], processor).onMessage(
        bridgeMessage(`r${i}`)
      );
    }
    const noRef = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('no WebView ref')
    );
    expect(noRef).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('captures events without a ref, and only skips the reply', () => {
    const bridge = attachWebViewBridge(undefined, [ORIGIN], processor);
    expect(bridge.onMessage(bridgeMessage('m1'))).toBe(true);
    expect(bridge.onMessage(bridgeMessage('m2'))).toBe(true);
    expect(received).toHaveLength(2);
  });

  it('survives a reply that fails to deliver', () => {
    ref.current = {
      injectJavaScript: () => {
        throw new Error('navigated away');
      },
    };
    const bridge = attachWebViewBridge(ref, [ORIGIN], processor);
    expect(bridge.onMessage(bridgeMessage('m1'))).toBe(true);
    expect(received).toHaveLength(1);
  });

  it('shares dedup across repeated attaches of the same processor (re-renders)', () => {
    attachWebViewBridge(ref, [ORIGIN], processor).onMessage(
      bridgeMessage('m1')
    );
    attachWebViewBridge(ref, [ORIGIN], processor).onMessage(
      bridgeMessage('m1')
    );
    expect(received).toHaveLength(1);
  });
});

describe('originOf', () => {
  it.each([
    ['https://shop.example.com/cart?x=1#y', 'https://shop.example.com'],
    ['https://shop.example.com', 'https://shop.example.com'],
    ['HTTPS://Shop.Example.com:443/', 'https://shop.example.com'],
    ['http://localhost:8081/index.html', 'http://localhost:8081'],
    ['http://[::1]:3000/', 'http://[::1]:3000'],
    ['https://user:pw@shop.example.com/', 'https://shop.example.com'],
    // Backslash ends the authority, as browsers parse http(s) URLs.
    ['https://evil.com\\@shop.example.com/', 'https://evil.com'],
    ['https://evil.com\\.shop.example.com', 'https://evil.com'],
  ])('%s → %s', (url, origin) => {
    expect(originOf(url)).toBe(origin);
  });

  it.each([['about:blank'], ['data:text/html,hi'], [''], [undefined]])(
    'has no origin for %p',
    (url) => {
      expect(originOf(url as any)).toBeNull();
    }
  );
});

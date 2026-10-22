import vm from 'vm';
import {
  BRIDGE_MESSAGE_PREFIX,
  buildBridgeWrapperScript,
  buildReplyScript,
  NATIVE_CHANNEL_NAME,
  WRAPPER_VERSION,
} from './bridgeWrapperScript';
import { parseBridgeEnvelope } from './bridgeEnvelope';

const ORIGIN = 'https://shop.example.com';

/** Runs the wrapper in a minimal page and returns what it posted. */
function runInPage(
  script: string,
  opts: { origin?: string; withChannel?: boolean } = {}
) {
  const posted: string[] = [];
  const origin = opts.origin ?? ORIGIN;
  const window: Record<string, any> = {};
  if (opts.withChannel !== false) {
    window.ReactNativeWebView = { postMessage: (d: string) => posted.push(d) };
  }
  const context = vm.createContext({
    window,
    location: {
      origin,
      href: `${origin}/cart?step=2`,
      pathname: '/cart',
      search: '?step=2',
    },
    document: { title: 'Cart', referrer: `${origin}/` },
    JSON,
    Math,
    Date,
    String,
    Uint8Array,
  });
  vm.runInContext(script, context);
  const envelopes = () =>
    posted.map((p) => {
      expect(p.startsWith(BRIDGE_MESSAGE_PREFIX)).toBe(true);
      return p.slice(BRIDGE_MESSAGE_PREFIX.length);
    });
  return { window, posted, envelopes, context };
}

describe('buildBridgeWrapperScript', () => {
  it('defines the bridge with track and page on an allowlisted page', () => {
    const { window } = runInPage(buildBridgeWrapperScript([ORIGIN]));
    expect(typeof window.metarouterBridge.track).toBe('function');
    expect(typeof window.metarouterBridge.page).toBe('function');
    expect(window[NATIVE_CHANNEL_NAME].onmessage).toBeNull();
  });

  it('defines nothing on a page outside the allowlist', () => {
    const { window } = runInPage(buildBridgeWrapperScript([ORIGIN]), {
      origin: 'https://evil.example.com',
    });
    expect(window.metarouterBridge).toBeUndefined();
    expect(window[NATIVE_CHANNEL_NAME]).toBeUndefined();
  });

  it('posts a prefixed envelope that round-trips through the parser', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    page.window.metarouterBridge.track('Added', { sku: 'A1' });
    page.window.metarouterBridge.page('Cart', JSON.stringify({ n: 2 }));

    const [track, pageView] = page.envelopes().map(parseBridgeEnvelope);
    expect(track).toMatchObject({
      valid: true,
      envelope: {
        version: 1,
        type: 'track',
        name: 'Added',
        properties: { sku: 'A1' },
        page: {
          url: `${ORIGIN}/cart?step=2`,
          path: '/cart',
          search: '?step=2',
          title: 'Cart',
          referrer: `${ORIGIN}/`,
        },
        source: { producer: 'wrapper', wrapperVersion: WRAPPER_VERSION },
      },
    });
    expect(pageView).toMatchObject({
      valid: true,
      envelope: { type: 'page', properties: { n: 2 } },
    });
    expect(track!.valid && track.envelope.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops calls with a blank name, and calls before the channel exists', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]), {
      withChannel: false,
    });
    page.window.metarouterBridge.track('E');
    page.window.metarouterBridge.track('');
    expect(page.posted).toHaveLength(0);
  });

  it('does not redefine an existing bridge', () => {
    const script = buildBridgeWrapperScript([ORIGIN]);
    const page = runInPage(script);
    const first = page.window.metarouterBridge;
    vm.runInContext(script, page.context);
    expect(page.window.metarouterBridge).toBe(first);
  });

  it('coerces unserializable properties so the parser rejects them, never throwing into the page', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      page.window.metarouterBridge.track('E', circular)
    ).not.toThrow();
    const result = parseBridgeEnvelope(page.envelopes()[0]!);
    expect(result).toMatchObject({ valid: false, code: 'malformed_payload' });
  });

  it('forwards an unparseable properties string as-is for the parser to reject', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    page.window.metarouterBridge.track('E', '{bad');
    expect(parseBridgeEnvelope(page.envelopes()[0]!)).toMatchObject({
      valid: false,
      code: 'malformed_payload',
    });
  });

  it('escapes origins containing quotes', () => {
    const script = buildBridgeWrapperScript(['https://a.com"];alert(1);//']);
    expect(script).toContain('["https://a.com\\"];alert(1);//"]');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('honors a custom bridge object name', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN], 'mrb'));
    expect(typeof page.window.mrb.track).toBe('function');
    expect(page.window.metarouterBridge).toBeUndefined();
  });

  it('rejects an empty origin list and an invalid object name', () => {
    expect(() => buildBridgeWrapperScript([])).toThrow();
    expect(() => buildBridgeWrapperScript([ORIGIN], 'not valid')).toThrow();
  });
});

describe('buildReplyScript', () => {
  it('delivers the reply string to the channel onmessage', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    const received: unknown[] = [];
    page.window[NATIVE_CHANNEL_NAME].onmessage = (e: unknown) =>
      received.push(e);
    const reply = JSON.stringify({ status: 'ok', messageId: 'm"1' });

    vm.runInContext(buildReplyScript(reply, [ORIGIN]), page.context);

    expect(received).toEqual([{ data: reply }]);
  });

  it('escapes U+2028/U+2029 so echoed text cannot break the script', () => {
    const reply = JSON.stringify({
      status: 'error',
      messageId: 'a\u2028b\u2029c',
    });
    const script = buildReplyScript(reply, [ORIGIN]);
    expect(script).not.toMatch(/[\u2028\u2029]/);
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    const received: { data: string }[] = [];
    page.window[NATIVE_CHANNEL_NAME].onmessage = (e: { data: string }) =>
      received.push(e);
    vm.runInContext(script, page.context);
    expect(received[0]!.data).toBe(reply);
  });

  it('does not deliver to a page whose origin is not allowlisted', () => {
    // The WebView navigated between the message and its reply.
    const page = runInPage(
      buildBridgeWrapperScript(['https://other.example.com']),
      {
        origin: 'https://other.example.com',
      }
    );
    const received: unknown[] = [];
    page.window[NATIVE_CHANNEL_NAME].onmessage = (e: unknown) =>
      received.push(e);
    vm.runInContext(buildReplyScript('{}', [ORIGIN]), page.context);
    expect(received).toHaveLength(0);
  });

  it('uses the given message prefix', () => {
    const page = runInPage(
      buildBridgeWrapperScript([ORIGIN], 'metarouterBridge', 'P:token:')
    );
    page.window.metarouterBridge.track('E');
    expect(page.posted[0]!.startsWith('P:token:{')).toBe(true);
  });

  it('is a no-op when the page set no onmessage', () => {
    const page = runInPage(buildBridgeWrapperScript([ORIGIN]));
    expect(() =>
      vm.runInContext(buildReplyScript('{}', [ORIGIN]), page.context)
    ).not.toThrow();
  });
});

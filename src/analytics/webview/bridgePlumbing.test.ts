import { AppState } from 'react-native';
import { BridgeMessageProcessor } from './bridgeMessageProcessor';
import { attachWebViewBridge } from './webViewBridge';
import type { AnalyticsInterface, InitOptions } from '../types';
import { MetaRouterAnalyticsClient } from '../MetaRouterAnalyticsClient';

jest.spyOn(AppState, 'addEventListener').mockImplementation(jest.fn());

jest.mock('../utils/identityStorage', () => ({
  getIdentityField: jest.fn(async (key: string) =>
    key === 'metarouter:anonymous_id' ? 'anon-123' : undefined
  ),
  setIdentityField: jest.fn(() => Promise.resolve()),
  removeIdentityField: jest.fn(() => Promise.resolve()),
  ANONYMOUS_ID_KEY: 'metarouter:anonymous_id',
  USER_ID_KEY: 'metarouter:user_id',
  GROUP_ID_KEY: 'metarouter:group_id',
  ADVERTISING_ID_KEY: 'metarouter:advertising_id',
}));

const ORIGIN = 'https://shop.example.com';
const opts: InitOptions = {
  ingestionHost: 'https://example.com',
  writeKey: 'test_write_key',
};

const PAGE = {
  url: `${ORIGIN}/cart?step=2`,
  path: '/cart',
  search: '?step=2',
  title: 'Cart',
  referrer: '',
};

// The session-token prefix the page would post with, read from the wrapper.
const prefixOf = (props: { injectedJavaScriptBeforeContentLoaded: string }) =>
  /"(__metaRouterBridge:[0-9a-f-]+:)"/.exec(
    props.injectedJavaScriptBeforeContentLoaded
  )![1]!;

const bridgeMessage = (
  prefix: string,
  messageId: string,
  extra: object = {}
) => ({
  nativeEvent: {
    url: `${ORIGIN}/cart`,
    data:
      prefix +
      JSON.stringify({
        version: 1,
        messageId,
        type: 'track',
        name: 'Added To Cart',
        properties: { sku: 'A1' },
        sentAt: '2020-01-01T00:00:00.000Z',
        page: PAGE,
        ...extra,
      }),
  },
});

// The direct client has no attachWebView; the public path wires it to a
// processor exactly like this (init.ts).
const attachTo = (
  client: MetaRouterAnalyticsClient,
  ref: Parameters<typeof attachWebViewBridge>[0] = null
) =>
  attachWebViewBridge(
    ref,
    [ORIGIN],
    new BridgeMessageProcessor((e) => client.enqueueBridgeEvent(e))
  );

describe('WebView bridge plumbing (direct client)', () => {
  beforeEach(() => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
  });

  it('enqueues bridge events with page context and native enrichment', async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    const bridge = attachTo(client);

    bridge.onMessage(bridgeMessage(prefixOf(bridge), 'web-msg-1'));
    client.track('Native Event');

    const [web, native] = (client as any).queue;
    expect(web).toMatchObject({
      type: 'track',
      event: 'Added To Cart',
      properties: { sku: 'A1' },
      anonymousId: 'anon-123',
      writeKey: 'test_write_key',
    });
    expect(web.context.page).toEqual(PAGE);
    // Session stamp lands beside the page, untouched by it.
    expect(web.context.providers.metarouter.sessionID).toEqual(
      native.context.providers.metarouter.sessionID
    );
    // messageId and timestamp are native, not the page's.
    expect(web.messageId).not.toBe('web-msg-1');
    expect(web.timestamp).not.toBe('2020-01-01T00:00:00.000Z');
    expect(native.context.page).toBeUndefined();
    await client.reset();
  });

  it('maps a bridge page call to a page event', async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    const bridge = attachTo(client);
    bridge.onMessage(
      bridgeMessage(prefixOf(bridge), 'm1', { type: 'page', name: 'Cart' })
    );
    expect((client as any).queue[0]).toMatchObject({
      type: 'page',
      event: 'Cart',
    });
    await client.reset();
  });

  it('answers not_ready before init, and accepts the retry after', async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    const injected: string[] = [];
    const bridge = attachTo(client, {
      current: { injectJavaScript: (s) => injected.push(s) },
    });
    const prefix = prefixOf(bridge);

    bridge.onMessage(bridgeMessage(prefix, 'm1'));
    expect(injected[0]).toContain('not_ready');

    await client.init();
    bridge.onMessage(bridgeMessage(prefix, 'm1'));
    expect(injected[1]).toContain('\\"status\\":\\"ok\\"');
    expect((client as any).queue).toHaveLength(1);
    await client.reset();
  });
});

describe('WebView bridge plumbing (public API)', () => {
  let analytics: AnalyticsInterface;

  // Called inside each test, not in beforeEach: Jest yields between the two,
  // and the client would already be bound before the test body runs.
  const create = () => {
    jest.isolateModules(() => {
      analytics = require('../init').createAnalyticsClient(opts);
    });
    return analytics;
  };

  beforeEach(() => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(async () => {
    await analytics.reset();
  });

  it('hands out working props before the client binds', async () => {
    // attachWebView is called at the first render, before init settles; the
    // same props must keep working once the client is bound.
    const injected: string[] = [];
    const bridge = create().attachWebView(
      { current: { injectJavaScript: (s) => injected.push(s) } },
      [ORIGIN]
    );
    expect(bridge.injectedJavaScriptBeforeContentLoaded).toContain(ORIGIN);
    const prefix = prefixOf(bridge);

    bridge.onMessage(bridgeMessage(prefix, 'm1'));
    expect(injected[0]).toContain('not_ready');

    await analytics.getAnonymousId(); // bound
    bridge.onMessage(bridgeMessage(prefix, 'm1'));
    expect(injected[1]).toContain('\\"status\\":\\"ok\\"');

    const debug = await analytics.getDebugInfo();
    expect(debug.queueLength).toBe(1);
  });

  it('dedups across re-rendered props', async () => {
    await create().getAnonymousId();
    const first = analytics.attachWebView(null, [ORIGIN]);
    const second = analytics.attachWebView(null, [ORIGIN]);
    expect(prefixOf(second)).toBe(prefixOf(first));
    first.onMessage(bridgeMessage(prefixOf(first), 'm1'));
    second.onMessage(bridgeMessage(prefixOf(second), 'm1'));
    expect((await analytics.getDebugInfo()).queueLength).toBe(1);
  });
});

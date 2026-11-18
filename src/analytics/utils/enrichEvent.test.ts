import { enrichEvent } from './enrichEvent';
import { EventContext, EventWithIdentity } from '../types';
import packageJson from '../../../package.json'; // Adjust the path as necessary

const context: EventContext = {
  library: {
    name: 'metarouter-react-native-sdk',
    version: packageJson.version,
  },
  locale: 'en-US',
  timezone: 'America/Denver',
  device: {
    manufacturer: 'Apple',
    model: 'iPhone 14',
    name: 'unknown',
    type: 'ios',
  },
  os: {
    name: 'iOS',
    version: '17.0',
  },
  app: {
    name: 'metarouter-react-native',
    version: '2.3.4',
    build: '567',
    namespace: 'unknown',
  },
  screen: {
    width: 100,
    height: 100,
    density: 1,
  },
  network: {
    wifi: true,
  },
};

describe('enrichEvent()', () => {
  const baseEvent: EventWithIdentity = {
    type: 'track',
    event: 'Product Viewed',
    properties: { sku: 'abc123' },
    timestamp: '2025-01-01T00:00:00.000Z',
    anonymousId: 'anon-123',
  };

  const writeKey = 'test-key';
  const session = {
    sessionId: '1757400000000',
    sessionCount: 2,
    startedNewSession: false,
  };

  it('enriches an event with required metadata', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context, session);

    expect(enriched.writeKey).toBe(writeKey);
    expect(enriched.timestamp).toBe(baseEvent.timestamp);
  });

  it('injects context with expected fields', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context, session);

    expect(enriched.context).toMatchObject({
      library: {
        name: 'metarouter-react-native-sdk',
        version: packageJson.version,
      },
      locale: 'en-US',
      timezone: 'America/Denver',
    });
  });

  it('stamps the session at context.providers.metarouter on a copy of the context', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context, session);

    expect(enriched.context.providers).toEqual({
      metarouter: { sessionID: '1757400000000', sessionCount: 2 },
    });
    expect(context.providers).toBeUndefined();
  });

  it('adds context.page beside the session stamp when given one', () => {
    const page = { url: 'https://shop.example.com/cart', path: '/cart' };
    const enriched = enrichEvent(baseEvent, writeKey, context, session, page);
    expect(enriched.context.page).toEqual(page);
    expect(enriched.context.providers).toBeDefined();
    expect(
      enrichEvent(baseEvent, writeKey, context, session).context
    ).not.toHaveProperty('page');
  });

  it('includes advertisingId in context when present', () => {
    const contextWithAd: EventContext = {
      ...context,
      device: {
        ...context.device,
        advertisingId: 'IDFA-12345-67890-ABCDEF',
      },
    };

    const enriched = enrichEvent(baseEvent, writeKey, contextWithAd, session);

    expect(enriched.context.device.advertisingId).toBe(
      'IDFA-12345-67890-ABCDEF'
    );
  });

  it('excludes advertisingId from context when not present', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context, session);

    expect(enriched.context.device.advertisingId).toBeUndefined();
  });
});

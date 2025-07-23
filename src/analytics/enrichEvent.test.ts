import { enrichEvent } from './enrichEvent';
import { EventContext, EventPayload, EventWithIdentity } from './types';
import packageJson from '../../package.json'; // Adjust the path as necessary

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

  it('enriches an event with required metadata', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context);

    expect(enriched.writeKey).toBe(writeKey);
    expect(new Date(enriched.sentAt).toString()).not.toBe('Invalid Date');
    expect(enriched.timestamp).toBe(baseEvent.timestamp);
  });


  it('injects context with expected fields', () => {
    const enriched = enrichEvent(baseEvent, writeKey, context);

    expect(enriched.context).toMatchObject({
      library: {
        name: 'metarouter-react-native-sdk',
        version: packageJson.version,
      },
      locale: 'en-US',
      timezone: 'America/Denver',
    });
  });
});
import { enrichEvent } from './enrichEvent';
import { EventPayload, EventWithIdentity } from './types';
import packageJson from '../../package.json'; // Adjust the path as necessary

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
    const enriched = enrichEvent(baseEvent, writeKey);

    expect(enriched.writeKey).toBe(writeKey);
    expect(new Date(enriched.sentAt).toString()).not.toBe('Invalid Date');
    expect(enriched.timestamp).toBe(baseEvent.timestamp);
  });


  it('injects context with expected fields', () => {
    const enriched = enrichEvent(baseEvent, writeKey);

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
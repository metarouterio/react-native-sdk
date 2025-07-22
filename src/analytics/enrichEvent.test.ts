import { enrichEvent } from './enrichEvent';
import { EventPayload } from './types';
import packageJson from '../../package.json'; // Adjust the path as necessary

describe('enrichEvent()', () => {
  const baseEvent: EventPayload = {
    type: 'track',
    event: 'Product Viewed',
    properties: { sku: 'abc123' },
    timestamp: '2025-01-01T00:00:00.000Z',
  };

  const anonId = 'anon-123';
  const writeKey = 'test-key';

  it('enriches an event with required metadata', () => {
    const enriched = enrichEvent(baseEvent, anonId, writeKey);

    expect(enriched.anonymousId).toBe(anonId);
    expect(enriched.writeKey).toBe(writeKey);
    expect(enriched.messageId).toMatch(/^(\d+)-/); // has timestamp prefix
    expect(new Date(enriched.sentAt).toString()).not.toBe('Invalid Date');
    expect(enriched.timestamp).toBe(baseEvent.timestamp);
  });

  it('generates timestamp if not provided', () => {
    const partial: EventPayload = {
      type: 'track',
      event: 'Missing Timestamp',
    };

    const enriched = enrichEvent(partial, anonId, writeKey);
    expect(enriched.timestamp).toBeDefined();
    const timestamp = enriched.timestamp!;
    expect(new Date(timestamp).toString()).not.toBe('Invalid Date');
  });

  it('injects context with expected fields', () => {
    const enriched = enrichEvent(baseEvent, anonId, writeKey);

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
import { DestinationPlugin, PluginType, SegmentEvent } from '@segment/analytics-react-native';

export class MetaRouterPlugin extends DestinationPlugin {
  // Required by Segment
  key = 'MetaRouterDestination';
  type = PluginType.destination

  constructor(private ingestionEndpoint: string, private writeKey: string) {
    super();
  }

  async execute(event: SegmentEvent) {
    const enrichedEvent = {
      ...event,
      writeKey: this.writeKey,
    };

    await fetch(this.ingestionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enrichedEvent),
    });

    return event;
  }
}
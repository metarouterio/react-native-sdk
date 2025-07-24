export type EventType =
  | "track"
  | "identify"
  | "group"
  | "screen"
  | "alias"
  | "page";

export interface EventPayload {
  type: EventType;
  event?: string;
  userId?: string;
  groupId?: string;
  traits?: Record<string, any>;
  properties?: Record<string, any>;
  timestamp?: string;
}

export interface EventWithIdentity extends EventPayload {
  anonymousId: string;
}

export interface EnrichedEventPayload extends EventWithIdentity {
  messageId: string;
  sentAt: string;
  context: EventContext;
  writeKey: string;
}

export interface InitOptions {
  writeKey: string;
  ingestionHost: string;
  flushInterval?: number;
  debug?: boolean;
}

export interface AnalyticsInterface {
  track: (event: string, props?: Record<string, any>) => void;
  identify: (userId: string, traits?: Record<string, any>) => void;
  group: (groupId: string, traits?: Record<string, any>) => void;
  screen: (name: string, props?: Record<string, any>) => void;
  alias: (newUserId: string) => void;
  flush: () => void;
  cleanup: () => void;
  enableDebugLogging?: () => void;
  getDebugInfo?: () => Record<string, any>;
}

export interface EventContext {
  app: {
    name: string;
    version: string;
    build: string;
    namespace: string;
  };
  device: {
    manufacturer: string;
    model: string;
    name: string;
    type: string;
  };
  library: {
    name: string;
    version: string;
  };
  os: {
    name: string;
    version: string;
  };
  screen: {
    density: number;
    width: number;
    height: number;
  };
  network: {
    wifi: boolean;
  };
  locale: string;
  timezone: string;
  [key: string]: any; // allow arbitrary context
}

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
  context: EventContext;
  writeKey: string;
}

export interface InitOptions {
  writeKey: string;
  ingestionHost: string;
  flushIntervalSeconds?: number;
  debug?: boolean;
  /** Max events held in memory; oldest are dropped once cap is hit (default: 2000) */
  maxQueueEvents?: number;
}

export interface AnalyticsInterface {
  track: (event: string, props?: Record<string, any>) => void;
  identify: (userId: string, traits?: Record<string, any>) => void;
  group: (groupId: string, traits?: Record<string, any>) => void;
  screen: (name: string, props?: Record<string, any>) => void;
  page: (name: string, props?: Record<string, any>) => void;
  alias: (newUserId: string) => void;
  flush: () => Promise<void>;
  reset: () => Promise<void>;
  enableDebugLogging: () => void;
  getDebugInfo: () => Promise<Record<string, any>>;
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

export type Lifecycle =
  | "idle"
  | "initializing"
  | "ready"
  | "resetting"
  | "disabled";

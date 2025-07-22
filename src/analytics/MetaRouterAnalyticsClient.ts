import { EventPayload, InitOptions } from "./types";
import { AppState, AppStateStatus } from 'react-native';
import { retryWithBackoff } from "./utils/retry";
import { log, setDebugLogging, warn } from "./utils/logger";
import { IdentityManager } from "./IdentityManager";

  
  export class MetaRouterAnalyticsClient {
    private initialized = false;
    private queue: EventPayload[] = [];
    private flushIntervalMs = 10000;
    private flushTimer: NodeJS.Timeout | null = null;
    private endpoint: string;
    private writeKey: string;
    private appState: AppStateStatus = AppState.currentState;
    private appStateSubscription: { remove?: () => void } | null = null;
    private identityManager: IdentityManager;
  
    constructor(options: InitOptions) {
      log('Initializing analytics client', options);
      const { writeKey, ingestionEndpoint, flushInterval } = options;
      this.endpoint = ingestionEndpoint;
      this.writeKey = writeKey;
      this.flushIntervalMs = flushInterval ?? 10000;
      setDebugLogging(options.debug ?? false);
      this.identityManager = new IdentityManager();
      this.init();
    }
  

    private async init() {
      if (this.initialized) return;
      await this.identityManager.init();
      this.startFlushLoop();
      this.setupAppStateListener();
      this.initialized = true;
      log('Analytics client initialized');
    }

    private startFlushLoop() {
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    }

    private now() {
      return new Date().toISOString();
    }
  
    private enqueue(event: EventPayload) {
      const eventWithIdentity = this.identityManager.addIdentityInfo(event);
      log('Enqueuing event', eventWithIdentity);
      this.queue.push(eventWithIdentity);
    }

    private setupAppStateListener() {
     this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
    }
  
    private handleAppStateChange = (nextState: AppStateStatus) => {
      if (this.appState === 'active' && nextState.match(/inactive|background/)) {
        this.flush(); 
      }
      this.appState = nextState;
    };

  
    track(event: string, properties?: Record<string, any>) {
      this.enqueue({ type: 'track', event, properties, timestamp: this.now() });
    }
  
    identify(userId: string, traits?: Record<string, any>) {
      this.identityManager.identify(userId);
      this.enqueue({ type: 'identify', userId, traits, timestamp: this.now() });
    }

    page(name: string, properties?: Record<string, any>) {
      this.enqueue({ type: 'page', event: name, properties, timestamp: this.now() });
    }
  
    group(groupId: string, traits?: Record<string, any>) {
      this.identityManager.group(groupId);
      this.enqueue({ type: 'group', groupId, traits, timestamp: this.now() });
    }
  
    screen(name: string, properties?: Record<string, any>) {
      this.enqueue({ type: 'screen', event: name, properties, timestamp: this.now() });
    }
  
    /**
    * Alias an anonymous user to a known user ID.
    * This updates internal identity state and enqueues an alias event.
    */
   
    alias(newUserId: string) {
      this.identityManager.identify(newUserId);
      this.enqueue({ type: 'alias', userId: newUserId, timestamp: this.now() });
    }
  
    async flush() {
      const anonId = this.identityManager.getAnonymousId();
      if (!anonId) {
        log('Anonymous ID not yet ready, delaying flush');
        // Anon ID not yet ready, delay flushing
        return;
      }
    
      if (this.queue.length === 0) return;
    
      const batch = this.queue.map((event) => ({
        ...event,
        anonymousId: anonId,
        writeKey: this.writeKey,
        messageId: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        sentAt: new Date().toISOString(),
      }));
    
      this.queue = [];

      log(`Flushing ${batch.length} events to ${this.endpoint}/v1/batch`);
    
      try {
        await retryWithBackoff(async () => {
          await fetch(this.endpoint + '/v1/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ batch }),
        });
      });

      log('Flush completed');
      return batch;
      } catch (err) {
        warn('Flush failed, re-queueing events', err);
        this.queue.unshift(...batch); // re-queue enriched events
      }
    }

    reset() {
      this.identityManager.reset();
      this.queue = [];
      log('Analytics client reset');
    }
  
    cleanup() {
      log('Cleaning up analytics client');
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.queue = [];
      this.flushTimer = null;
      this.appStateSubscription?.remove?.();

    }
  }
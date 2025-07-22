import { getAnonymousId } from "./utils/anonymousId";
import { log, warn } from "./utils/logger";

export class IdentityManager {
    private anonymousId: string | null = null;
    private userId?: string;
    private groupId?: string;

  
    async init(): Promise<void> {
      try {
        this.anonymousId = await getAnonymousId(); // load or generate
        log('IdentityManager initialized with anonymous ID:', this.anonymousId);
      } catch (error) {
        warn('Failed to initialize IdentityManager, using fallback anonymous ID', error);
        // Fallback: generate a temporary anonymous ID
        this.anonymousId = `fallback-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
        log('Using fallback anonymous ID:', this.anonymousId);
      }
    }
  
    getAnonymousId(): string | null {
      return this.anonymousId;
    }
  
    identify(userId: string) {
      this.userId = userId;
      log('User identified:', userId);
    }
  
    group(groupId: string) {
      this.groupId = groupId;
      log('User grouped:', groupId);
    }
  
    getUserId(): string | undefined {
      return this.userId;
    }
  
    getGroupId(): string | undefined {
      return this.groupId;
    }
  
    addIdentityInfo<T extends Record<string, any>>(event: T): T {
      return {
        ...event,
        anonymousId: this.anonymousId,
        userId: event.userId ?? this.userId,
        groupId: event.groupId ?? this.groupId,
      };
    }

    reset() {
      this.anonymousId = null;
      this.userId = undefined;
      this.groupId = undefined;
      log('IdentityManager reset');
    }
  }
import { getAnonymousId } from "./utils/anonymousId";

export class IdentityManager {
    private anonymousId: string | null = null;
    private userId?: string;
    private groupId?: string;

  
    async init(): Promise<void> {
      this.anonymousId = await getAnonymousId(); // load or generate
    }
  
    getAnonymousId(): string | null {
      return this.anonymousId;
    }
  
    identify(userId: string) {
      this.userId = userId;

    }
  
    group(groupId: string) {
      this.groupId = groupId;
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
    }
  }
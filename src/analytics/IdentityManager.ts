import { getAnonymousId } from "./utils/anonymousId";
import { log, warn } from "./utils/logger";
import { EventPayload, EventWithIdentity } from "./types";

/**
 * Manages user, group, and anonymous identity for analytics events.
 * - Loads or generates a persistent anonymous ID.
 * - Tracks current user and group IDs.
 * - Can enrich events with identity information.
 * - Supports reset for logout/testing scenarios.
 */
export class IdentityManager {
    private anonymousId: string | null = null;
    private userId?: string;
    private groupId?: string;

    /**
   * Initializes the manager by loading or generating an anonymous ID.
   * Should be called before using other methods.
   */
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
  
    /**
     * Retrieves the current anonymous ID.
     * @returns The anonymous ID or null if not initialized.
     */
    getAnonymousId(): string | null {
      return this.anonymousId;
    }
  
    /**
     * Sets the user ID for the current session.
     * @param userId - The user ID to set.
     */
    identify(userId: string) {
      this.userId = userId;
      log('User identified:', userId);
    }
  
    /**
     * Sets the group ID for the current session.
     * @param groupId - The group ID to set.
     */
    group(groupId: string) {
      this.groupId = groupId;
      log('User grouped:', groupId);
    }
  
    /**
     * Retrieves the current user ID.
     * @returns The user ID or undefined if not set.
     */
    getUserId(): string | undefined {
      return this.userId;
    }
  
    /**
     * Retrieves the current group ID.
     * @returns The group ID or undefined if not set.
     */
    getGroupId(): string | undefined {
      return this.groupId;
    }
  
    /**
     * Adds identity information to an event payload.
     * @param event - The event payload to enrich.
     * @returns The enriched event payload with identity information.
     */
    addIdentityInfo<T extends EventPayload>(event: T): EventWithIdentity {   
      return {
        ...event,
        anonymousId: this.anonymousId ?? 'unknown',
        userId: event.userId ?? this.userId,
        groupId: event.groupId ?? this.groupId,
      };
    }

    /**
     * Resets the identity manager to its initial state.
     * Clears all user and group IDs, and sets the anonymous ID to null.
     */
    reset() {
      this.anonymousId = null;
      this.userId = undefined;
      this.groupId = undefined;
      log('IdentityManager reset');
    }
  }
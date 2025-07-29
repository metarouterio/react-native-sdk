import { log, warn } from "./utils/logger";
import { EventPayload, EventWithIdentity } from "./types";
import { USER_ID_KEY, GROUP_ID_KEY, ANONYMOUS_ID_KEY, getIdentityField, setIdentityField, removeIdentityField } from './utils/identityStorage';

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
        const storedAnonId = await getIdentityField(ANONYMOUS_ID_KEY);
        if (!storedAnonId) {
          const newId = `anon-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
          await setIdentityField(ANONYMOUS_ID_KEY, newId);
          this.anonymousId = newId;
          log('Generated and stored new anonymous ID:', newId);
        } else {
          this.anonymousId = storedAnonId;
          log('Loaded stored anonymous ID:', storedAnonId);
        }
    
        this.userId = await getIdentityField(USER_ID_KEY) || undefined;
        this.groupId = await getIdentityField(GROUP_ID_KEY) || undefined;
        log('IdentityManager initialized with anonymous ID:', this.anonymousId, 'userId:', this.userId, 'groupId:', this.groupId);
      } catch (error) {
        warn('Failed to initialize IdentityManager, using fallback anonymous ID', error);
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
    async identify(userId: string) {
      this.userId = userId;
      try {
        await setIdentityField(USER_ID_KEY, userId);
      } catch (error) {
        warn('Failed to persist userId', error);
      }
      log('User identified:', userId);
    }
  
    /**
     * Sets the group ID for the current session.
     * @param groupId - The group ID to set.
     */
    async group(groupId: string) {
      this.groupId = groupId;
      try {
        await setIdentityField(GROUP_ID_KEY, groupId);
      } catch (error) {
        warn('Failed to persist groupId', error);
      }
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
    async reset() {
      this.anonymousId = null;
      this.userId = undefined;
      this.groupId = undefined;
      try {
        await removeIdentityField(ANONYMOUS_ID_KEY);
        await removeIdentityField(USER_ID_KEY);
        await removeIdentityField(GROUP_ID_KEY);
      } catch (error) {
        warn('Failed to clear userId/groupId/anonymousId from storage', error);
      }
      log('IdentityManager reset');
    }
  }
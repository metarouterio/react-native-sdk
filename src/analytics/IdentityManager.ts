import { log, warn } from './utils/logger';
import uuid from 'react-native-uuid';
import { EventPayload, EventWithIdentity } from './types';
import {
  USER_ID_KEY,
  GROUP_ID_KEY,
  ANONYMOUS_ID_KEY,
  HOST_SET_MARKER_KEY,
  currentIdentityEpoch,
  readIdentityFields,
  setIdentityField,
  removeIdentityField,
} from './utils/identityStorage';
import { utf8ByteLength } from './utils/utf8';

/**
 * Longest accepted host anonymousId, in UTF-8 bytes (as on iOS and Android).
 * Generous for any web or vendor id (a UUID is 36), and it rides on every event.
 */
export const MAX_HOST_ANONYMOUS_ID_BYTES = 256;

/** First 8 characters, as the SDKs log identifiers. */
export const maskId = (id: string | null | undefined): string =>
  id ? `${id.slice(0, 8)}***` : 'not loaded yet';

/**
 * The trimmed id, or null (with a warning) when it is rejected: empty after
 * trimming, or over 256 UTF-8 bytes. No format check: passing the id the web
 * SDK actually sends is the host's job. `current` is only for the warning.
 */
export function validateHostAnonymousId(
  raw: unknown,
  current: string | null
): string | null {
  const unchanged = `anonymousId unchanged (${maskId(current)}).`;
  if (typeof raw !== 'string') {
    warn(`setAnonymousId rejected: the value is not a string. ${unchanged}`);
    return null;
  }
  // Unicode whitespace, but not U+FEFF: String.prototype.trim() strips it,
  // and the iOS and Android SDKs keep it.
  const id = raw.replace(/^[^\S\uFEFF]+|[^\S\uFEFF]+$/g, '');
  if (id === '') {
    warn(
      `setAnonymousId rejected: the value is empty after trimming whitespace. ${unchanged}`
    );
    return null;
  }
  const bytes = utf8ByteLength(id);
  if (bytes > MAX_HOST_ANONYMOUS_ID_BYTES) {
    warn(
      `setAnonymousId rejected: ${maskId(id)} is ${bytes} UTF-8 bytes, over the ${MAX_HOST_ANONYMOUS_ID_BYTES}-byte limit. ${unchanged}`
    );
    return null;
  }
  return id;
}

/**
 * Manages user, group, and anonymous identity for analytics events.
 * - Loads or generates a persistent anonymous ID.
 * - Adopts an anonymous ID the host sets (setHostAnonymousId).
 * - Tracks current user and group IDs.
 * - Can enrich events with identity information.
 * - Supports reset for logout/testing scenarios.
 */
export class IdentityManager {
  private anonymousId: string | null = null;
  private userId?: string;
  private groupId?: string;
  private loaded = false;
  // A host id set while init() is reading: init() adopts it instead of the
  // stored or generated one. Storage already has it (init.ts writes it).
  private hostAnonymousId: string | null = null;
  /**
   * @param epoch - The identity epoch of the decision that built this client
   *   (see utils/identityStorage): its writes are dropped once a reset() or a
   *   refusal has been called since.
   */
  constructor(private readonly epoch: number = currentIdentityEpoch()) {}

  /**
   * Loads the stored ids, or generates and stores an anonymous ID. Reads are
   * retried; an anonymous ID that still cannot be read is replaced for this
   * launch only and never written over the stored one, so a storage hiccup
   * cannot change the device's identity.
   */
  async init(): Promise<void> {
    const [anon, user, group, marker] = await readIdentityFields([
      ANONYMOUS_ID_KEY,
      USER_ID_KEY,
      GROUP_ID_KEY,
      HOST_SET_MARKER_KEY,
    ]);

    // Synchronous from here: a setHostAnonymousId() made during the reads
    // above is in hostAnonymousId, and one made after sees loaded = true.
    this.userId = (user.ok && user.raw) || undefined;
    this.groupId = (group.ok && group.raw) || undefined;
    if (!user.ok || !group.ok) {
      warn('Failed to read the stored userId/groupId; continuing without them');
    }

    // Install detection has read the marker before this init: it has done its
    // job. Also when a host id arrived during the reads above: its write,
    // queued after them, may set the marker, and this removal queues after it.
    if (!marker.ok || marker.raw || this.hostAnonymousId !== null) {
      void removeIdentityField(HOST_SET_MARKER_KEY, this.epoch);
    }

    if (this.hostAnonymousId !== null) {
      this.anonymousId = this.hostAnonymousId;
      this.hostAnonymousId = null;
      log('Adopted the host-set anonymous ID:', maskId(this.anonymousId));
    } else if (anon.ok && anon.raw) {
      this.anonymousId = anon.raw;
      log('Loaded stored anonymous ID:', maskId(this.anonymousId));
    } else if (anon.ok) {
      this.anonymousId = String(uuid.v4());
      void setIdentityField(ANONYMOUS_ID_KEY, this.anonymousId, this.epoch);
      log('Generated and stored new anonymous ID:', maskId(this.anonymousId));
    } else {
      this.anonymousId = String(uuid.v4());
      warn(
        'Failed to read the stored anonymous ID; using a new one for this launch without replacing the stored one',
        anon.error
      );
    }
    this.loaded = true;
  }

  /**
   * Retrieves the current anonymous ID.
   * @returns The anonymous ID or null if not initialized.
   */
  getAnonymousId(): string | null {
    return this.anonymousId;
  }

  /**
   * Adopts an anonymous ID the host set, in memory: init.ts validates it and
   * writes storage. Before init() has loaded, the id is held and init() adopts
   * it; after, it applies to the next event.
   */
  setHostAnonymousId(id: string): void {
    if (!this.loaded) {
      this.hostAnonymousId = id;
      return;
    }
    if (id === this.anonymousId) return;
    this.anonymousId = id;
    log('Host set the anonymous ID:', maskId(id));
  }

  /**
   * Sets the user ID for the current session.
   * @param userId - The user ID to set.
   */
  async identify(userId: string) {
    this.userId = userId;
    await setIdentityField(USER_ID_KEY, userId, this.epoch);
    log('User identified:', userId);
  }

  /**
   * Sets the group ID for the current session.
   * @param groupId - The group ID to set.
   */
  async group(groupId: string) {
    this.groupId = groupId;
    await setIdentityField(GROUP_ID_KEY, groupId, this.epoch);
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
   * Clears the ids in memory, for a client being torn down. Storage is cleared
   * where the teardown is decided (init.ts: reset(), or a refusal over a
   * running session), queued in call order with identity writes.
   */
  async reset() {
    this.anonymousId = null;
    this.userId = undefined;
    this.groupId = undefined;
    this.hostAnonymousId = null;
    this.loaded = false;
    log('IdentityManager reset');
  }
}

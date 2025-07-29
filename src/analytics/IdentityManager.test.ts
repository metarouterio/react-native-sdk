import { IdentityManager } from './IdentityManager';
import * as identityStorage from './utils/identityStorage';

jest.mock('./utils/identityStorage', () => ({
  getIdentityField: jest.fn(),
  setIdentityField: jest.fn(),
  removeIdentityField: jest.fn(),
  ANONYMOUS_ID_KEY: 'metarouter:anonymous_id',
  USER_ID_KEY: 'metarouter:user_id',
  GROUP_ID_KEY: 'metarouter:group_id',
}));

describe('IdentityManager', () => {
  let manager: IdentityManager;
  const getIdentityField = identityStorage.getIdentityField as jest.Mock;
  const setIdentityField = identityStorage.setIdentityField as jest.Mock;
  const removeIdentityField = identityStorage.removeIdentityField as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new IdentityManager();
    getIdentityField.mockImplementation(async (key: string) => {
      if (key === identityStorage.ANONYMOUS_ID_KEY) return 'anon-123';
      if (key === identityStorage.USER_ID_KEY) return undefined;
      if (key === identityStorage.GROUP_ID_KEY) return undefined;
      return undefined;
    });
    setIdentityField.mockResolvedValue(undefined);
    removeIdentityField.mockResolvedValue(undefined);
  });

  it('initializes anonymousId from storage', async () => {
    await manager.init();
    expect(getIdentityField).toHaveBeenCalledWith(identityStorage.ANONYMOUS_ID_KEY);
    expect(manager.getAnonymousId()).toBe('anon-123');
  });

  it('sets and gets userId', async () => {
    await manager.identify('user-456');
    expect(manager.getUserId()).toBe('user-456');
    expect(setIdentityField).toHaveBeenCalledWith(identityStorage.USER_ID_KEY, 'user-456');
  });

  it('sets and gets groupId', async () => {
    await manager.group('group-789');
    expect(manager.getGroupId()).toBe('group-789');
    expect(setIdentityField).toHaveBeenCalledWith(identityStorage.GROUP_ID_KEY, 'group-789');
  });

  it('adds identity info to event', async () => {
    await manager.init();
    await manager.identify('user-abc');
    await manager.group('group-xyz');

    const baseEvent = { type: 'track' as const, event: 'test' };
    const enriched = manager.addIdentityInfo(baseEvent);

    expect(enriched).toEqual({
      ...baseEvent,
      anonymousId: 'anon-123',
      userId: 'user-abc',
      groupId: 'group-xyz',
    });
  });

  it('does not override userId/groupId if already present in event', async () => {
    await manager.init();
    await manager.identify('fallback-user');
    await manager.group('fallback-group');

    const event = {
      type: 'track' as const,
      event: 'test',
      userId: 'explicit-user',
      groupId: 'explicit-group',
    };
    const enriched = manager.addIdentityInfo(event);

    expect(enriched.userId).toBe('explicit-user');
    expect(enriched.groupId).toBe('explicit-group');
  });

  it('resets internal state', async () => {
    await manager.init();
    await manager.identify('user-reset');
    await manager.group('group-reset');
    await manager.reset();

    expect(manager.getAnonymousId()).toBeNull();
    expect(manager.getUserId()).toBeUndefined();
    expect(manager.getGroupId()).toBeUndefined();
    expect(removeIdentityField).toHaveBeenCalledWith(identityStorage.ANONYMOUS_ID_KEY);
    expect(removeIdentityField).toHaveBeenCalledWith(identityStorage.USER_ID_KEY);
    expect(removeIdentityField).toHaveBeenCalledWith(identityStorage.GROUP_ID_KEY);
  });

  it('generates and stores a new anonymousId if not found in storage', async () => {
    getIdentityField.mockResolvedValueOnce(null); // No anon ID in storage
    await manager.init();

    const anonId = manager.getAnonymousId();

    expect(anonId).toMatch(/^anon-\d+-[a-z0-9]+$/); // basic shape check
    expect(setIdentityField).toHaveBeenCalledWith(identityStorage.ANONYMOUS_ID_KEY, anonId);
  });
});
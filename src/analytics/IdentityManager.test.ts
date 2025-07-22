import { IdentityManager } from './IdentityManager';
import { getAnonymousId } from './utils/anonymousId';

jest.mock('./utils/anonymousId', () => ({
  getAnonymousId: jest.fn(() => Promise.resolve('anon-123')),
}));

describe('IdentityManager', () => {
  let manager: IdentityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new IdentityManager();
  });

  it('initializes anonymousId from storage', async () => {
    await manager.init();
    expect(getAnonymousId).toHaveBeenCalled();
    expect(manager.getAnonymousId()).toBe('anon-123');
  });

  it('sets and gets userId', () => {
    manager.identify('user-456');
    expect(manager.getUserId()).toBe('user-456');
  });

  it('sets and gets groupId', () => {
    manager.group('group-789');
    expect(manager.getGroupId()).toBe('group-789');
  });

  it('adds identity info to event', async () => {
    await manager.init();
    manager.identify('user-abc');
    manager.group('group-xyz');

    const baseEvent = { type: 'track', event: 'test' };
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
    manager.identify('fallback-user');
    manager.group('fallback-group');

    const event = {
      type: 'track',
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
    manager.identify('user-reset');
    manager.group('group-reset');
    manager.reset();

    expect(manager.getAnonymousId()).toBeNull();
    expect(manager.getUserId()).toBeUndefined();
    expect(manager.getGroupId()).toBeUndefined();
  });
});
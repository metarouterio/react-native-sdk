import {
  PERSIST_THROTTLE_MS,
  SessionManager,
  type SessionInfo,
} from './sessionManager';
import type { StoredSession } from '../utils/sessionStorage';

const WALL_START = 1_757_400_000_000;
const MINUTE = 60_000;
const EMPTY: StoredSession = { id: null, count: null, lastActivityMs: null };

describe('SessionManager', () => {
  let wallNow: number;
  let monoNow: number;
  let stored: StoredSession;
  let saveSession: jest.Mock;
  let saveLastActivity: jest.Mock;

  beforeEach(() => {
    wallNow = WALL_START;
    monoNow = 0;
    stored = { ...EMPTY };
    saveSession = jest.fn((id, count, lastActivityMs) => {
      stored = { id, count, lastActivityMs };
    });
    saveLastActivity = jest.fn((lastActivityMs) => {
      stored = { ...stored, lastActivityMs };
    });
  });

  async function makeManager(timeoutMinutes = 30) {
    const manager = new SessionManager(timeoutMinutes, {
      load: async () => ({ ...stored }),
      saveSession,
      saveLastActivity,
      wallClockMs: () => wallNow,
      monotonicClockMs: () => monoNow,
    });
    await manager.loadPersisted();
    return manager;
  }

  it('cold start mints the first session from the wall clock', async () => {
    const manager = await makeManager();

    const info = manager.touch();

    expect(info).toEqual({
      sessionId: String(WALL_START),
      sessionCount: 1,
      startedNewSession: true,
    });
    expect(saveSession).toHaveBeenCalledWith(String(WALL_START), 1, WALL_START);
  });

  it('activity within the timeout extends the session', async () => {
    const manager = await makeManager();
    const first = manager.touch();

    monoNow += 29 * MINUTE;
    wallNow += 29 * MINUTE;
    const second = manager.touch();

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.startedNewSession).toBe(false);
  });

  it('the sliding window outlives the timeout measured from session start', async () => {
    const manager = await makeManager();
    const first = manager.touch();

    for (let i = 0; i < 4; i++) {
      monoNow += 20 * MINUTE;
      wallNow += 20 * MINUTE;
      expect(manager.touch().sessionId).toBe(first.sessionId);
    }
  });

  it('inactivity past the timeout rolls over and continues the counter', async () => {
    const manager = await makeManager();
    manager.touch();

    monoNow += 30 * MINUTE + 1;
    wallNow += 30 * MINUTE + 1;
    const next = manager.touch();

    expect(next).toEqual({
      sessionId: String(wallNow),
      sessionCount: 2,
      startedNewSession: true,
    });
  });

  it('exactly at the timeout is still the same session', async () => {
    const manager = await makeManager();
    const first = manager.touch();

    monoNow += 30 * MINUTE;
    wallNow += 30 * MINUTE;

    expect(manager.touch().sessionId).toBe(first.sessionId);
  });

  it('a wall-clock jump does not affect a live session', async () => {
    const manager = await makeManager();
    const first = manager.touch();

    // Clock set forward two hours with only a minute of real time elapsed.
    monoNow += MINUTE;
    wallNow += 120 * MINUTE;

    expect(manager.touch().sessionId).toBe(first.sessionId);
  });

  it('a restart within the timeout resumes the persisted session', async () => {
    stored = { id: '1757399000000', count: 4, lastActivityMs: WALL_START };
    wallNow = WALL_START + 10 * MINUTE;
    monoNow = 1_000;
    const manager = await makeManager();

    const info = manager.touch();

    expect(info).toEqual({
      sessionId: '1757399000000',
      sessionCount: 4,
      startedNewSession: false,
    });
    // Resume persists once, unthrottled, so the pre-restart stamp is not
    // left in place for a throttle window.
    expect(saveLastActivity).toHaveBeenCalledWith(wallNow);
  });

  it('a restart past the timeout mints and continues the counter', async () => {
    stored = { id: '1757399000000', count: 4, lastActivityMs: WALL_START };
    wallNow = WALL_START + 31 * MINUTE;
    const manager = await makeManager();

    const info = manager.touch();

    expect(info.startedNewSession).toBe(true);
    expect(info.sessionCount).toBe(5);
    expect(info.sessionId).toBe(String(wallNow));
  });

  it('a restart with a future last activity mints a new session', async () => {
    // The clock was set back since the last write: resuming would keep the
    // session alive until the clock catches up.
    stored = {
      id: '1757399000000',
      count: 2,
      lastActivityMs: WALL_START + 60 * MINUTE,
    };
    const manager = await makeManager();

    const info = manager.touch();

    expect(info.startedNewSession).toBe(true);
    expect(info.sessionCount).toBe(3);
  });

  it('a restart with partial state mints instead of resuming', async () => {
    // Id present but no last activity: a window of unknown age.
    stored = { id: '1757400000000', count: 1, lastActivityMs: null };
    wallNow = WALL_START + 10 * MINUTE;
    const manager = await makeManager();

    const info = manager.touch();

    expect(info.startedNewSession).toBe(true);
    expect(info.sessionCount).toBe(2);
  });

  it('a resumed session with no stored count reports 1', async () => {
    stored = { id: '1757399000000', count: null, lastActivityMs: WALL_START };
    const manager = await makeManager();

    expect(manager.touch().sessionCount).toBe(1);
  });

  it('a touch before loadPersisted settles mints over the stored session', () => {
    // Pins the contract init() relies on: the load must settle first.
    stored = { id: '1757399000000', count: 4, lastActivityMs: WALL_START };
    const manager = new SessionManager(30, {
      load: async () => ({ ...stored }),
      saveSession,
      saveLastActivity,
      wallClockMs: () => wallNow,
      monotonicClockMs: () => monoNow,
    });

    expect(manager.touch()).toMatchObject({
      sessionCount: 1,
      startedNewSession: true,
    });
  });

  it('extends persist at most once per throttle window, on the monotonic clock', async () => {
    const manager = await makeManager();
    manager.touch();
    saveLastActivity.mockClear();

    // Wall time races ahead of monotonic time: a throttle measured on the
    // wall clock would persist here.
    monoNow += PERSIST_THROTTLE_MS - 1;
    wallNow += 10 * PERSIST_THROTTLE_MS;
    manager.touch();
    expect(saveLastActivity).not.toHaveBeenCalled();

    monoNow += 1;
    manager.touch();
    expect(saveLastActivity).toHaveBeenCalledTimes(1);
    expect(saveLastActivity).toHaveBeenCalledWith(wallNow);
  });

  it('peek is null before the first touch', async () => {
    const manager = await makeManager();

    expect(manager.peek()).toBeNull();
  });

  it('peek does not extend the session', async () => {
    const manager = await makeManager();
    const first = manager.touch();

    monoNow += 20 * MINUTE;
    expect(manager.peek()?.sessionId).toBe(first.sessionId);

    // 31 minutes after the last touch; the peek at 20 must not count.
    monoNow += 11 * MINUTE;
    expect(manager.touch().startedNewSession).toBe(true);
  });

  it('loadPersisted is a no-op once the process has a session', async () => {
    const manager = await makeManager();
    const first = manager.touch();
    stored = { id: 'other', count: 9, lastActivityMs: wallNow };

    await manager.loadPersisted();
    monoNow += 31 * MINUTE;

    // Counter continues from memory, not from the late-loaded state.
    expect(manager.touch().sessionCount).toBe(first.sessionCount + 1);
  });

  it('fires the start handler once per mint, after the minting touch returns', async () => {
    const manager = await makeManager();
    const started: SessionInfo[] = [];
    const order: string[] = [];
    manager.setOnSessionStart((info) => {
      order.push('handler');
      started.push(info);
      // The handler's own event re-enters touch() without minting again.
      expect(manager.touch().startedNewSession).toBe(false);
    });

    manager.touch();
    order.push('after touch');
    manager.touch();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['after touch', 'handler']);
    expect(started).toHaveLength(1);
    expect(started[0]!.sessionCount).toBe(1);
  });

  it('persistActivity writes the latest activity inside the throttle window', async () => {
    const manager = await makeManager();
    manager.touch();
    saveLastActivity.mockClear();

    monoNow += 1_000;
    wallNow += 1_000;
    manager.touch(); // throttled
    expect(saveLastActivity).not.toHaveBeenCalled();

    manager.persistActivity();
    expect(saveLastActivity).toHaveBeenCalledWith(wallNow);
  });

  it('persistActivity is a no-op before the first touch', async () => {
    const manager = await makeManager();
    manager.persistActivity();
    expect(saveLastActivity).not.toHaveBeenCalled();
  });

  it('rejects a non-positive timeout', () => {
    expect(() => new SessionManager(0)).toThrow('timeoutMinutes must be > 0');
    expect(() => new SessionManager(NaN)).toThrow('timeoutMinutes must be > 0');
  });
});

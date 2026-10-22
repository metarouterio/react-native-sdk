import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadSession,
  saveLastActivity,
  saveSession,
  SESSION_COUNT_KEY,
  SESSION_ID_KEY,
  SESSION_LAST_ACTIVITY_KEY,
} from './sessionStorage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  multiGet: jest.fn(),
  multiSet: jest.fn(() => Promise.resolve()),
  setItem: jest.fn(() => Promise.resolve()),
}));

const multiGet = AsyncStorage.multiGet as jest.Mock;
const multiSet = AsyncStorage.multiSet as jest.Mock;
const setItem = AsyncStorage.setItem as jest.Mock;

function storeValues(values: Record<string, string | null>) {
  multiGet.mockImplementation(async (keys: string[]) =>
    keys.map((k) => [k, values[k] ?? null])
  );
}

describe('sessionStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the native SDKs key names', () => {
    expect(SESSION_ID_KEY).toBe('metarouter:session:id');
    expect(SESSION_COUNT_KEY).toBe('metarouter:session:count');
    expect(SESSION_LAST_ACTIVITY_KEY).toBe(
      'metarouter:session:last_activity_ms'
    );
  });

  it('loads a stored session', async () => {
    storeValues({
      [SESSION_ID_KEY]: '1757400000000',
      [SESSION_COUNT_KEY]: '3',
      [SESSION_LAST_ACTIVITY_KEY]: '1757400060000',
    });

    await expect(loadSession()).resolves.toEqual({
      id: '1757400000000',
      count: 3,
      lastActivityMs: 1_757_400_060_000,
    });
  });

  it('reads missing or corrupt numbers as absent', async () => {
    storeValues({
      [SESSION_ID_KEY]: '1757400000000',
      [SESSION_COUNT_KEY]: 'abc',
      [SESSION_LAST_ACTIVITY_KEY]: '1.5',
    });

    await expect(loadSession()).resolves.toEqual({
      id: '1757400000000',
      count: null,
      lastActivityMs: null,
    });
  });

  it('reads nothing stored as an empty session, not a failure', async () => {
    storeValues({});

    await expect(loadSession()).resolves.toEqual({
      id: null,
      count: null,
      lastActivityMs: null,
    });
  });

  it('rejects a count below 1 and an empty value', async () => {
    for (const count of ['', '0', '-5']) {
      storeValues({
        [SESSION_ID_KEY]: 'x',
        [SESSION_COUNT_KEY]: count,
        [SESSION_LAST_ACTIVITY_KEY]: '',
      });
      await expect(loadSession()).resolves.toEqual({
        id: 'x',
        count: null,
        lastActivityMs: null,
      });
    }
  });

  it('retries a failed read after a backoff', async () => {
    const delay = jest.fn(() => Promise.resolve());
    multiGet.mockRejectedValueOnce(new Error('busy'));
    storeValues({ [SESSION_ID_KEY]: 'x', [SESSION_COUNT_KEY]: '5' });

    await expect(loadSession(delay)).resolves.toMatchObject({
      id: 'x',
      count: 5,
    });
    expect(multiGet).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(100);
  });

  it('reads storage that stays unreadable as empty, with a warning', async () => {
    const delay = jest.fn(() => Promise.resolve());
    multiGet.mockRejectedValue(new Error('storage unavailable'));
    const logger = require('./logger');
    const warnSpy = jest.spyOn(logger, 'warn');

    await expect(loadSession(delay)).resolves.toEqual({
      id: null,
      count: null,
      lastActivityMs: null,
    });
    expect(multiGet).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Session storage unreadable'),
      expect.any(Error)
    );
  });

  it('writes a new session in one multiSet', () => {
    saveSession('1757400000000', 2, 1_757_400_000_000);

    expect(multiSet).toHaveBeenCalledTimes(1);
    expect(multiSet).toHaveBeenCalledWith([
      [SESSION_ID_KEY, '1757400000000'],
      [SESSION_COUNT_KEY, '2'],
      [SESSION_LAST_ACTIVITY_KEY, '1757400000000'],
    ]);
  });

  it('swallows a failed write', async () => {
    setItem.mockRejectedValueOnce(new Error('disk full'));

    expect(() => saveLastActivity(1)).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(SESSION_LAST_ACTIVITY_KEY, '1');
    await Promise.resolve();
  });
});

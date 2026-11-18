import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSession, saveSession, SESSION_KEY } from './sessionStorage';

// getItem/setItem only: the calls AsyncStorage 2.x and 3.x both have.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(() => Promise.resolve()),
}));

const getItem = AsyncStorage.getItem as jest.Mock;
const setItem = AsyncStorage.setItem as jest.Mock;

function storeValue(value: unknown) {
  getItem.mockImplementation(async (key: string) =>
    key === SESSION_KEY && value !== undefined
      ? typeof value === 'string'
        ? value
        : JSON.stringify(value)
      : null
  );
}

const EMPTY = { id: null, count: null, lastActivityMs: null };

describe('sessionStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads a stored session', async () => {
    storeValue({
      id: '1757400000000',
      count: 3,
      lastActivityMs: 1_757_400_060_000,
    });

    await expect(loadSession()).resolves.toEqual({
      id: '1757400000000',
      count: 3,
      lastActivityMs: 1_757_400_060_000,
    });
  });

  it('reads missing or corrupt fields as absent', async () => {
    storeValue({ id: '1757400000000', count: 'abc', lastActivityMs: 1.5 });

    await expect(loadSession()).resolves.toEqual({
      id: '1757400000000',
      count: null,
      lastActivityMs: null,
    });
  });

  it('reads nothing stored as an empty session, not a failure', async () => {
    const delay = jest.fn(() => Promise.resolve());
    storeValue(undefined);

    await expect(loadSession(delay)).resolves.toEqual(EMPTY);
    expect(delay).not.toHaveBeenCalled();
  });

  it('rejects a count below 1 and an empty id', async () => {
    for (const count of [0, -5]) {
      storeValue({ id: '', count, lastActivityMs: -1 });
      await expect(loadSession()).resolves.toEqual(EMPTY);
    }
  });

  it('reads an unparseable value as empty at once, with a warning', async () => {
    const delay = jest.fn(() => Promise.resolve());
    const logger = require('./logger');
    const warnSpy = jest.spyOn(logger, 'warn');

    for (const value of ['{not json', 'null', '42']) {
      storeValue(value);
      await expect(loadSession(delay)).resolves.toEqual(EMPTY);
    }
    // The same bad value would fail every retry.
    expect(delay).not.toHaveBeenCalled();
    expect(getItem).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stored session is corrupt'),
      '{not json'
    );
  });

  it('retries a failed read after a backoff', async () => {
    const delay = jest.fn(() => Promise.resolve());
    storeValue({ id: 'x', count: 5 });
    getItem.mockRejectedValueOnce(new Error('busy'));

    await expect(loadSession(delay)).resolves.toMatchObject({
      id: 'x',
      count: 5,
    });
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(100);
  });

  it('reads storage that stays unreadable as empty, with a warning', async () => {
    const delay = jest.fn(() => Promise.resolve());
    getItem.mockRejectedValue(new Error('storage unavailable'));
    const logger = require('./logger');
    const warnSpy = jest.spyOn(logger, 'warn');

    await expect(loadSession(delay)).resolves.toEqual(EMPTY);
    expect(getItem).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Session storage unreadable'),
      expect.any(Error)
    );
  });

  it('writes the whole session in one setItem', () => {
    saveSession('1757400000000', 2, 1_757_400_000_000);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0]![0]).toBe(SESSION_KEY);
    expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual({
      id: '1757400000000',
      count: 2,
      lastActivityMs: 1_757_400_000_000,
    });
  });

  it('round-trips what it writes', async () => {
    saveSession('1757400000000', 2, 1_757_400_000_000);
    storeValue(setItem.mock.calls[0]![1]);

    await expect(loadSession()).resolves.toEqual({
      id: '1757400000000',
      count: 2,
      lastActivityMs: 1_757_400_000_000,
    });
  });

  it('swallows a rejected write', async () => {
    setItem.mockRejectedValueOnce(new Error('disk full'));

    expect(() => saveSession('x', 1, 1)).not.toThrow();
    await Promise.resolve();
  });

  it('swallows a write that throws synchronously', () => {
    setItem.mockImplementationOnce(() => {
      throw new TypeError('setItem is not a function');
    });

    expect(() => saveSession('x', 1, 1)).not.toThrow();
  });
});

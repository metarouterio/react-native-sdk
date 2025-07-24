// src/analytics/utils/anonymousId.test.ts

import { getAnonymousId } from './anonymousId';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

// Import after jest.mock so the mock is applied
const AsyncStorage = require('@react-native-async-storage/async-storage');
const getItemMock = AsyncStorage.getItem as jest.Mock;
const setItemMock = AsyncStorage.setItem as jest.Mock;

describe('getAnonymousId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing ID from storage', async () => {
    getItemMock.mockResolvedValue('existing-id');
    const id = await getAnonymousId();
    expect(id).toBe('existing-id');
    expect(getItemMock).toHaveBeenCalledWith('metarouter:anonymous_id');
  });

  it('generates and stores a new ID if none exists', async () => {
    getItemMock.mockResolvedValue(null);
    setItemMock.mockResolvedValue(undefined);
    const id = await getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    expect(setItemMock).toHaveBeenCalledWith('metarouter:anonymous_id', id);
  });

  it('handles storage read failure gracefully', async () => {
    getItemMock.mockRejectedValue(new Error('read error'));
    setItemMock.mockResolvedValue(undefined);
    const id = await getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    expect(setItemMock).toHaveBeenCalledWith('metarouter:anonymous_id', id);
  });

  it('handles storage write failure gracefully', async () => {
    getItemMock.mockResolvedValue(null);
    setItemMock.mockRejectedValue(new Error('write error'));
    const id = await getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    // Even if setItem fails, we still return the generated ID
  });

  it('returns a new ID if storage is cleared', async () => {
    getItemMock.mockResolvedValueOnce('id1');
    let id = await getAnonymousId();
    expect(id).toBe('id1');

    getItemMock.mockResolvedValueOnce(null);
    setItemMock.mockResolvedValue(undefined);
    id = await getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id).not.toBe('id1');
  });
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAnonymousId } from './anonymousId';
import { v4 as uuidv4 } from 'uuid';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

describe('getAnonymousId', () => {
  const STORAGE_KEY = 'metarouter:anonymous_id';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing anonymousId if found in storage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('anon-abc');

    const id = await getAnonymousId();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(id).toBe('anon-abc');
  });

  it('generates and stores a new UUID if none exists', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (uuidv4 as jest.Mock).mockReturnValue('anon-generated');

    const id = await getAnonymousId();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(uuidv4).toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, 'anon-generated');
    expect(id).toBe('anon-generated');
  });
});
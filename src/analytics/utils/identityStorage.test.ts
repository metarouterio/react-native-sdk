import { getIdentityField, setIdentityField, removeIdentityField, ANONYMOUS_ID_KEY, USER_ID_KEY, GROUP_ID_KEY } from './identityStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

describe('identityStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gets identity field from AsyncStorage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('value-1');
    const value = await getIdentityField(ANONYMOUS_ID_KEY);
    expect(value).toBe('value-1');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(ANONYMOUS_ID_KEY);
  });

  it('returns null if getItem throws', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('fail'));
    const value = await getIdentityField(USER_ID_KEY);
    expect(value).toBeNull();
  });

  it('sets identity field in AsyncStorage', async () => {
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    await setIdentityField(GROUP_ID_KEY, 'group-123');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(GROUP_ID_KEY, 'group-123');
  });

  it('does not throw if setItem fails', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('fail'));
    await expect(setIdentityField(USER_ID_KEY, 'user-abc')).resolves.toBeUndefined();
  });

  it('removes identity field from AsyncStorage', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    await removeIdentityField(ANONYMOUS_ID_KEY);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(ANONYMOUS_ID_KEY);
  });

  it('does not throw if removeItem fails', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValue(new Error('fail'));
    await expect(removeIdentityField(GROUP_ID_KEY)).resolves.toBeUndefined();
  });
});

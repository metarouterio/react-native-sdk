import {
  getLifecycleVersion,
  getLifecycleBuild,
  setLifecycleVersionBuild,
  LIFECYCLE_VERSION_KEY,
  LIFECYCLE_BUILD_KEY,
} from './lifecycleStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

describe('lifecycleStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the lifecycle version key from AsyncStorage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('1.4.0');

    const version = await getLifecycleVersion();

    expect(version).toBe('1.4.0');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(LIFECYCLE_VERSION_KEY);
  });

  it('reads the lifecycle build key from AsyncStorage', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('42');

    const build = await getLifecycleBuild();

    expect(build).toBe('42');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(LIFECYCLE_BUILD_KEY);
  });

  it('returns null when version key is missing', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    expect(await getLifecycleVersion()).toBeNull();
    expect(await getLifecycleBuild()).toBeNull();
  });

  it('returns null when AsyncStorage throws on read', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('boom'));

    expect(await getLifecycleVersion()).toBeNull();
    expect(await getLifecycleBuild()).toBeNull();
  });

  it('writes both version and build to AsyncStorage', async () => {
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);

    await setLifecycleVersionBuild('1.4.0', '42');

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      LIFECYCLE_VERSION_KEY,
      '1.4.0'
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      LIFECYCLE_BUILD_KEY,
      '42'
    );
  });

  it('does not throw if write fails', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('fail'));

    await expect(setLifecycleVersionBuild('1.0', '1')).resolves.toBeUndefined();
  });
});

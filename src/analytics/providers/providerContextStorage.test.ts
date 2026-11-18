import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import {
  loadProviderContext,
  loadProviderContextSync,
  PROVIDER_CONTEXT_KEY,
  saveProviderContext,
} from './providerContextStorage';

const noDelay = () => Promise.resolve();
const native = NativeModules.MetaRouterKeyValueStore as {
  getSync: jest.Mock;
  setSync: jest.Mock;
};

describe('providerContextStorage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the native SDKs key', () => {
    expect(PROVIDER_CONTEXT_KEY).toBe('metarouter:providers:context');
  });

  it('round-trips a map as one JSON value through native storage', async () => {
    await saveProviderContext({ p: { k: [1, 'a'] } });
    const [key, raw] = native.setSync.mock.calls[0];
    expect(key).toBe(PROVIDER_CONTEXT_KEY);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();

    native.getSync.mockReturnValueOnce(raw);
    expect(loadProviderContextSync()).toEqual({ p: { k: [1, 'a'] } });
  });

  it('removes the key for an empty map', async () => {
    await saveProviderContext({});
    expect(native.setSync).toHaveBeenCalledWith(PROVIDER_CONTEXT_KEY, null);
    expect(loadProviderContextSync()).toBeNull();
  });

  it('reads nothing stored as null', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await expect(loadProviderContext(noDelay)).resolves.toBeNull();
  });

  it.each([
    ['not json', '{'],
    ['not an object', '[1]'],
    ['a non-object block', '{"p":1}'],
  ])('reads corrupt state (%s) as unset', async (_, raw) => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(raw);
    await expect(loadProviderContext(noDelay)).resolves.toBeNull();
  });

  it('drops empty provider blocks and keeps "__proto__" as a name', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      '{"empty":{},"__proto__":{"k":1}}'
    );
    const map = await loadProviderContext(noDelay);
    expect(Object.keys(map!)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
  });

  it('retries a failed read, and throws when it keeps failing', async () => {
    (AsyncStorage.getItem as jest.Mock)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce('{"p":{"k":1}}');
    await expect(loadProviderContext(noDelay)).resolves.toEqual({
      p: { k: 1 },
    });

    // Unreadable is not "nothing stored": reading it as empty would let the
    // next save replace the stored map.
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('gone'));
    await expect(loadProviderContext(noDelay)).rejects.toThrow('gone');
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(() =>
      Promise.resolve(null)
    );
  });
});

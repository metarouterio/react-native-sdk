import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { persistedValue, resetNativeStoreForTests } from './persistedValue';

const noDelay = () => Promise.resolve();
const native = NativeModules.MetaRouterKeyValueStore as {
  getSync: jest.Mock;
  setSync: jest.Mock;
};

describe('persistedValue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps queued once-values; a failed test must not leak one.
    native.getSync.mockReset().mockReturnValue(null);
    native.setSync.mockReset().mockReturnValue(true);
    resetNativeStoreForTests();
  });

  describe('with the native module', () => {
    const value = persistedValue('k');

    it('reads synchronously: the stored string, or null when nothing is stored', () => {
      native.getSync.mockReturnValueOnce('{"a":1}');
      expect(value.readSync()).toBe('{"a":1}');
      expect(value.readSync()).toBeNull();
    });

    it.each([
      [
        'throws',
        () => {
          throw new Error('sync calls unsupported');
        },
      ],
      ['returns undefined', () => undefined],
      ['returns a Promise', () => Promise.resolve('v')],
    ])(
      'a native read that %s throws rather than reading as nothing stored',
      (_, impl) => {
        native.getSync.mockImplementationOnce(impl);
        expect(() => value.readSync()).toThrow();
      }
    );

    it('writes go to native storage only; null removes', async () => {
      await value.write('v');
      await value.write(null);
      expect(native.setSync.mock.calls).toEqual([
        ['k', 'v'],
        ['k', null],
      ]);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    });

    it.each([
      ['false', false],
      ['a Promise', Promise.resolve(true)],
    ])(
      'a native write returning %s is not confirmed, so the save is reported',
      async (_, result) => {
        native.setSync.mockReturnValueOnce(result);
        await expect(value.write('v')).rejects.toThrow('could not write k');
      }
    );
  });

  describe('without the native module', () => {
    const saved = NativeModules.MetaRouterKeyValueStore;
    beforeEach(() => {
      delete NativeModules.MetaRouterKeyValueStore;
    });
    afterEach(() => {
      NativeModules.MetaRouterKeyValueStore = saved;
    });

    it('is not available synchronously; reads and writes AsyncStorage', async () => {
      const value = persistedValue('k');
      expect(value.readSync()).toBeUndefined();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('v');
      await expect(value.read(noDelay)).resolves.toBe('v');

      await value.write('w');
      expect(AsyncStorage.setItem).toHaveBeenCalledWith('k', 'w');
      await value.write(null);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith('k');
    });

    it('a read that keeps failing throws', async () => {
      const value = persistedValue('k');
      const getItem = AsyncStorage.getItem as jest.Mock;
      const original = getItem.getMockImplementation();
      getItem.mockRejectedValue(new Error('busy'));
      try {
        await expect(value.read(noDelay)).rejects.toThrow('busy');
      } finally {
        getItem.mockImplementation(original);
      }
    });
  });
});

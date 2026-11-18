import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import {
  CONSENT_KEY,
  loadConsent,
  loadConsentSync,
  saveConsent,
} from './consentStorage';

const noDelay = () => Promise.resolve();
const native = NativeModules.MetaRouterKeyValueStore as {
  getSync: jest.Mock;
  setSync: jest.Mock;
};

describe('consentStorage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the native SDKs key', () => {
    expect(CONSENT_KEY).toBe('metarouter:consent:state');
  });

  it('round-trips the raw snapshot and watermark as one JSON value through native storage', async () => {
    await saveConsent({
      consent: { explicit: true, optOut: { c0001: true }, timestamp: 5 },
      lastHostTimestamp: 5,
    });
    const [key, raw] = native.setSync.mock.calls[0];
    expect(key).toBe(CONSENT_KEY);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();

    native.getSync.mockReturnValueOnce(raw);
    expect(loadConsentSync()).toEqual({
      consent: { explicit: true, optOut: { c0001: true }, timestamp: 5 },
      lastHostTimestamp: 5,
    });
  });

  it('a clear removes the native record, and nothing stored reads as null', async () => {
    await saveConsent(null);
    expect(native.setSync).toHaveBeenCalledWith(CONSENT_KEY, null);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();

    native.getSync.mockReturnValueOnce(null);
    expect(loadConsentSync()).toBeNull();
    native.getSync.mockReturnValueOnce(
      '{"consent":{"explicit":true,"optOut":{}}}'
    );
    expect(loadConsentSync()).toEqual({
      consent: { explicit: true, optOut: {} },
    });
  });

  it.each([
    ['not json', '{'],
    ['no consent', '{"lastHostTimestamp":1}'],
    ['bad explicit', '{"consent":{"explicit":1,"optOut":{}}}'],
    ['bad optOut value', '{"consent":{"explicit":true,"optOut":{"a":1}}}'],
  ])('reads corrupt state (%s) as never set', async (_, raw) => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(raw);
    await expect(loadConsent(noDelay)).resolves.toBeNull();
  });

  it('tolerates unknown fields', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      '{"consent":{"explicit":false,"optOut":{},"future":1},"extra":true}'
    );
    await expect(loadConsent(noDelay)).resolves.toEqual({
      consent: { explicit: false, optOut: {} },
    });
  });

  it('throws when the read keeps failing', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('gone'));
    await expect(loadConsent(noDelay)).rejects.toThrow('gone');
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(() =>
      Promise.resolve(null)
    );
  });
});

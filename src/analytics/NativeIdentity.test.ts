describe('NativeIdentity', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function getNativeModules() {
    return require('react-native').NativeModules;
  }

  it('resolves a string when the native module returns a string', async () => {
    getNativeModules().MetaRouterIdentity = {
      getAnonymousId: jest.fn(() => Promise.resolve('anon-abc-123')),
    };
    const { getAnonymousId } = require('./NativeIdentity');
    const result = await getAnonymousId();
    expect(result).toBe('anon-abc-123');
  });

  it('resolves null when the native module returns null', async () => {
    getNativeModules().MetaRouterIdentity = {
      getAnonymousId: jest.fn(() => Promise.resolve(null)),
    };
    const { getAnonymousId } = require('./NativeIdentity');
    const result = await getAnonymousId();
    expect(result).toBeNull();
  });

  it('resolves null when the native module is missing', async () => {
    getNativeModules().MetaRouterIdentity = undefined;
    const { getAnonymousId } = require('./NativeIdentity');
    const result = await getAnonymousId();
    expect(result).toBeNull();
  });

  it('resolves null when the native module rejects unexpectedly', async () => {
    getNativeModules().MetaRouterIdentity = {
      getAnonymousId: jest.fn(() => Promise.reject(new Error('native crash'))),
    };
    const { getAnonymousId } = require('./NativeIdentity');
    const result = await getAnonymousId();
    expect(result).toBeNull();
  });
});

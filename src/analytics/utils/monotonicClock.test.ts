describe('continuousMillis', () => {
  function loadWith(clock: unknown) {
    let fn!: () => number;
    jest.isolateModules(() => {
      const rn = require('react-native');
      rn.NativeModules.MetaRouterClock = clock;
      fn = require('./monotonicClock').continuousMillis;
    });
    return fn;
  }

  afterEach(() => {
    require('react-native').NativeModules.MetaRouterClock = {
      continuousMillis: jest.fn(() => Date.now()),
    };
  });

  it('reads the native continuous clock', () => {
    const continuousMillis = loadWith({ continuousMillis: () => 42 });
    expect(continuousMillis()).toBe(42);
  });

  it('falls back to wall-clock without the native module', () => {
    jest.setSystemTime(1_757_400_000_000);
    const continuousMillis = loadWith(undefined);
    expect(continuousMillis()).toBe(1_757_400_000_000);
  });

  it('falls back instead of throwing when the sync call throws, and stops calling it', () => {
    // e.g. Chrome remote debugging: sync native methods are unsupported.
    const native = jest.fn(() => {
      throw new Error(
        'Calling synchronous methods on native modules is not supported'
      );
    });
    jest.setSystemTime(1_757_400_000_000);
    const continuousMillis = loadWith({ continuousMillis: native });

    expect(continuousMillis()).toBe(1_757_400_000_000);
    expect(continuousMillis()).toBe(1_757_400_000_000);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('bridge hiccup');
      },
    ],
    ['returns a non-number', () => undefined],
  ])(
    'continues from the last native reading when a later call %s',
    (_label, failure) => {
      // A switch straight to Date.now() would jump from boot-relative to
      // epoch ms and read as decades of inactivity.
      let calls = 0;
      const native = jest.fn(() => (++calls === 1 ? 100_000_000 : failure()));
      jest.setSystemTime(1_757_400_000_000);
      const continuousMillis = loadWith({ continuousMillis: native });

      expect(continuousMillis()).toBe(100_000_000);
      jest.setSystemTime(1_757_400_005_000);
      expect(continuousMillis()).toBe(100_005_000);
      jest.setSystemTime(1_757_400_006_000);
      expect(continuousMillis()).toBe(100_006_000);
      expect(native).toHaveBeenCalledTimes(2);
    }
  );
});

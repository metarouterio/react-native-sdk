jest.mock('./timezone', () => ({
  getTimeZone: jest.fn(() => 'America/New_York'),
}));

jest.mock('../../../package.json', () => ({
  version: '1.2.3',
}));

describe('getContextInfo', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('returns context info with DeviceInfo present', async () => {
    // Mock DeviceInfo module
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',

      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked();

    expect(context).toEqual({
      app: {
        build: '567',
        name: 'unknown',
        namespace: 'unknown',
        version: '2.3.4',
      },
      device: {
        manufacturer: 'Apple',
        model: 'iPhone17,2',
        type: 'ios',
      },
      library: {
        name: 'metarouter-react-native-sdk',
        version: '1.2.3',
      },
      locale: expect.stringMatching(/^[a-z]{2}-[A-Z]{2}$/),
      os: {
        name: 'iOS',
        version: '17.0',
      },
      screen: {
        density: 3,
        height: 844,
        width: 390,
      },
      timezone: 'America/New_York',
    });
  });

  it('returns fallback values when DeviceInfo is not available', async () => {
    // Mock DeviceInfo module to throw an error
    jest.doMock('react-native-device-info', () => {
      throw new Error('Module not available');
    });

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked();

    expect(context.device.manufacturer).toBe('unknown');
    expect(context.device.model).toBe('unknown');
    expect(context.app.version).toBe('1.2.3'); // fallback to pkg.version
  });

  it('includes advertisingId in device context when provided', async () => {
    // Mock DeviceInfo module
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',

      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const advertisingId = 'IDFA-12345-67890-ABCDEF';
    const context = await getContextInfoMocked(advertisingId);

    expect(context.device.advertisingId).toBe(advertisingId);
  });

  it('excludes advertisingId from device context when not provided', async () => {
    // Mock DeviceInfo module
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',

      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked();

    expect(context.device.advertisingId).toBeUndefined();
  });

  it('returns Android-specific device context with name and Build.MODEL', async () => {
    // Override Platform.OS to android
    const { Platform } = require('react-native');
    Platform.OS = 'android';

    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Zebra Technologies'),
      getModel: () => 'TC52',
      getDevice: () => Promise.resolve('TC52'),
      getDeviceId: () => 'tc52',
      getSystemName: () => 'Android',
      getSystemVersion: () => '14',
      getVersion: () => '1.5.0',
      getBuildNumber: () => '127',
      getApplicationName: () => 'SidelineAssist',
      getBundleId: () => 'com.sidelineassist',
      isWifiEnabled: () => Promise.resolve(true),
    }));

    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');
    const context = await getContextInfoMocked();

    expect(context.device).toEqual({
      manufacturer: 'Zebra Technologies',
      model: 'TC52',
      name: 'TC52',
      type: 'android',
    });
    expect(context.device.name).toBe('TC52');

    // Reset Platform
    Platform.OS = 'ios';
  });

  it('omits device name on iOS', async () => {
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getModel: () => 'iPhone 16 Pro Max',
      getDevice: () => Promise.resolve('iPhone17,2'),
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',
      isWifiEnabled: () => Promise.resolve(true),
    }));

    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');
    const context = await getContextInfoMocked();

    expect(context.device).toEqual({
      manufacturer: 'Apple',
      model: 'iPhone17,2',
      type: 'ios',
    });
    expect(context.device.name).toBeUndefined();
  });

  it('excludes advertisingId from device context when provided as undefined', async () => {
    // Mock DeviceInfo module
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',

      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked(undefined);

    expect(context.device.advertisingId).toBeUndefined();
  });
});

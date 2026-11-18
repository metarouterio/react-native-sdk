jest.mock('./timezone', () => ({
  getTimeZone: jest.fn(() => 'America/New_York'),
}));

jest.mock('../../../package.json', () => ({
  version: '1.2.3',
}));

const buildAppContext = (overrides: Partial<Record<string, string>> = {}) => ({
  name: 'unknown',
  version: '2.3.4',
  build: '567',
  namespace: 'unknown',
  ...overrides,
});

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
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked(buildAppContext());

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

    const context = await getContextInfoMocked(
      buildAppContext({ version: '1.2.3' })
    );

    expect(context.device.manufacturer).toBe('unknown');
    expect(context.device.model).toBe('unknown');
    expect(context.app.version).toBe('1.2.3');
  });

  it('carries no advertisingId or network: enrichment stamps those per event', async () => {
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
    }));

    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = await getContextInfoMocked(buildAppContext());

    expect(context.device.advertisingId).toBeUndefined();
    expect(context).not.toHaveProperty('network');
  });

  describe('Android', () => {
    let originalOS: string;

    beforeEach(() => {
      const { Platform } = require('react-native');
      originalOS = Platform.OS;
      Platform.OS = 'android';
    });

    afterEach(() => {
      const { Platform } = require('react-native');
      Platform.OS = originalOS;
    });

    it('returns device context with name and Build.MODEL', async () => {
      jest.doMock('react-native-device-info', () => ({
        getManufacturer: () => Promise.resolve('Samsung'),
        getModel: () => 'SM-G991B',
        getDevice: () => Promise.resolve('SM-G991B'),
        getDeviceId: () => 'o1s',
        getSystemName: () => 'Android',
        getSystemVersion: () => '14',
      }));

      const { getContextInfo: getContextInfoMocked } = require('./contextInfo');
      const context = await getContextInfoMocked(
        buildAppContext({
          name: 'TestApp',
          version: '1.5.0',
          build: '127',
          namespace: 'com.example.testapp',
        })
      );

      expect(context.device).toEqual({
        manufacturer: 'Samsung',
        model: 'SM-G991B',
        name: 'SM-G991B',
        type: 'android',
      });
      expect(context.device.name).toBe('SM-G991B');
    });
  });

  it('omits device name on iOS', async () => {
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => Promise.resolve('Apple'),
      getDeviceId: () => 'iPhone17,2',
      getModel: () => 'iPhone 16 Pro Max',
      getDevice: () => Promise.resolve('iPhone17,2'),
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
    }));

    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');
    const context = await getContextInfoMocked(buildAppContext());

    expect(context.device).toEqual({
      manufacturer: 'Apple',
      model: 'iPhone17,2',
      type: 'ios',
    });
    expect(context.device.name).toBeUndefined();
  });
});

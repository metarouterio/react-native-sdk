
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

  it('returns context info with DeviceInfo present', () => {
    // Mock DeviceInfo module
    jest.doMock('react-native-device-info', () => ({
      getManufacturer: () => 'Apple',
      getModel: () => 'iPhone 14',
      getSystemName: () => 'iOS',
      getSystemVersion: () => '17.0',
      getVersion: () => '2.3.4',
      getBuildNumber: () => '567',
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = getContextInfoMocked();

    expect(context).toEqual({
      app: {
        build: '567',
        name: 'metarouter-react-native',
        namespace: 'unknown',
        version: '2.3.4',
      },
      device: {
        manufacturer: 'Apple',
        model: 'iPhone 14',
        name: 'unknown',
        type: 'ios',
      },
      library: {
        name: 'metarouter-react-native-sdk',
        version: '1.2.3',
      },
      locale: expect.stringMatching(/^[a-z]{2}-[A-Z]{2}$/),
      network: {
        wifi: true,
      },
      os: {
        name: 'iOS',
        version: '17.0',
      },
      screen: {
        density: 2,
        height: 0,
        width: 0,
      },
      timezone: 'America/New_York',
    });
  });

  it('returns fallback values when DeviceInfo is not available', () => {
    // Mock DeviceInfo module to throw an error
    jest.doMock('react-native-device-info', () => {
      throw new Error('Module not available');
    });

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require('./contextInfo');

    const context = getContextInfoMocked();

    expect(context.device.manufacturer).toBe('unknown');
    expect(context.device.model).toBe('unknown');
    expect(context.app.version).toBe('1.2.3'); // fallback to pkg.version
  });
});
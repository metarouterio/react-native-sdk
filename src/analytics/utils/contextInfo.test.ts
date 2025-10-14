jest.mock("./timezone", () => ({
  getTimeZone: jest.fn(() => "America/New_York"),
}));

jest.mock("../../../package.json", () => ({
  version: "1.2.3",
}));

describe("getContextInfo", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("returns context info with DeviceInfo present", async () => {
    // Mock DeviceInfo module
    jest.doMock("react-native-device-info", () => ({
      getManufacturer: () => Promise.resolve("Apple"),
      getModel: () => "iPhone 14",
      getSystemName: () => "iOS",
      getSystemVersion: () => "17.0",
      getVersion: () => "2.3.4",
      getBuildNumber: () => "567",
      getDeviceName: () => Promise.resolve("iPhone 14"),
      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require("./contextInfo");

    const context = await getContextInfoMocked();

    expect(context).toEqual({
      app: {
        build: "567",
        name: "unknown",
        namespace: "unknown",
        version: "2.3.4",
      },
      device: {
        manufacturer: "Apple",
        model: "iPhone 14",
        name: "iPhone 14",
        type: "ios",
      },
      library: {
        name: "metarouter-react-native-sdk",
        version: "1.2.3",
      },
      locale: expect.stringMatching(/^[a-z]{2}-[A-Z]{2}$/),
      os: {
        name: "iOS",
        version: "17.0",
      },
      screen: {
        density: 3,
        height: 844,
        width: 390,
      },
      timezone: "America/New_York",
    });
  });

  it("returns fallback values when DeviceInfo is not available", async () => {
    // Mock DeviceInfo module to throw an error
    jest.doMock("react-native-device-info", () => {
      throw new Error("Module not available");
    });

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require("./contextInfo");

    const context = await getContextInfoMocked();

    expect(context.device.manufacturer).toBe("unknown");
    expect(context.device.model).toBe("unknown");
    expect(context.app.version).toBe("1.2.3"); // fallback to pkg.version
  });

  it("includes advertisingId in device context when provided", async () => {
    // Mock DeviceInfo module
    jest.doMock("react-native-device-info", () => ({
      getManufacturer: () => Promise.resolve("Apple"),
      getModel: () => "iPhone 14",
      getSystemName: () => "iOS",
      getSystemVersion: () => "17.0",
      getVersion: () => "2.3.4",
      getBuildNumber: () => "567",
      getDeviceName: () => Promise.resolve("iPhone 14"),
      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require("./contextInfo");

    const advertisingId = "IDFA-12345-67890-ABCDEF";
    const context = await getContextInfoMocked(advertisingId);

    expect(context.device.advertisingId).toBe(advertisingId);
  });

  it("excludes advertisingId from device context when not provided", async () => {
    // Mock DeviceInfo module
    jest.doMock("react-native-device-info", () => ({
      getManufacturer: () => Promise.resolve("Apple"),
      getModel: () => "iPhone 14",
      getSystemName: () => "iOS",
      getSystemVersion: () => "17.0",
      getVersion: () => "2.3.4",
      getBuildNumber: () => "567",
      getDeviceName: () => Promise.resolve("iPhone 14"),
      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require("./contextInfo");

    const context = await getContextInfoMocked();

    expect(context.device.advertisingId).toBeUndefined();
  });

  it("excludes advertisingId from device context when provided as undefined", async () => {
    // Mock DeviceInfo module
    jest.doMock("react-native-device-info", () => ({
      getManufacturer: () => Promise.resolve("Apple"),
      getModel: () => "iPhone 14",
      getSystemName: () => "iOS",
      getSystemVersion: () => "17.0",
      getVersion: () => "2.3.4",
      getBuildNumber: () => "567",
      getDeviceName: () => Promise.resolve("iPhone 14"),
      isWifiEnabled: () => Promise.resolve(true),
    }));

    // Re-import the module to get the mocked version
    const { getContextInfo: getContextInfoMocked } = require("./contextInfo");

    const context = await getContextInfoMocked(undefined);

    expect(context.device.advertisingId).toBeUndefined();
  });
});

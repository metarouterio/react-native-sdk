import type { InitOptions } from "./types";

// Mock fetch and identity storage as in MetaRouterAnalyticsClient.test.ts

global.fetch = jest.fn(() => Promise.resolve({ ok: true })) as any;

jest.mock("./utils/identityStorage", () => ({
  getIdentityField: jest.fn(),
  setIdentityField: jest.fn(),
  removeIdentityField: jest.fn(),
  ANONYMOUS_ID_KEY: "metarouter:anonymous_id",
  USER_ID_KEY: "metarouter:user_id",
  GROUP_ID_KEY: "metarouter:group_id",
}));

const opts: InitOptions = {
  ingestionHost: "https://example.com",
  writeKey: "test_write_key",
  flushIntervalSeconds: 5,
};

describe("createAnalyticsClient", () => {
  beforeEach(() => {
    jest.resetModules(); // Reset module registry to clear proxy state
    jest.clearAllMocks();
    const identityStorage = require("./utils/identityStorage");
    (identityStorage.getIdentityField as jest.Mock).mockImplementation(
      async (key: string) => {
        if (key === identityStorage.ANONYMOUS_ID_KEY) return "anon-123";
        return undefined;
      }
    );
    (identityStorage.setIdentityField as jest.Mock).mockResolvedValue(
      undefined
    );
    (identityStorage.removeIdentityField as jest.Mock).mockResolvedValue(
      undefined
    );
  });

  it("creates a client with all analytics methods", async () => {
    const { createAnalyticsClient } = require("./init");
    const client = await createAnalyticsClient(opts);
    expect(typeof client.track).toBe("function");
    expect(typeof client.identify).toBe("function");
    expect(typeof client.group).toBe("function");
    expect(typeof client.screen).toBe("function");
    expect(typeof client.page).toBe("function");
    expect(typeof client.alias).toBe("function");
    expect(typeof client.flush).toBe("function");
    expect(typeof client.reset).toBe("function");
    expect(typeof client.enableDebugLogging).toBe("function");
    expect(typeof client.getDebugInfo).toBe("function");
  });

  it("returns a new analytics interface each time", async () => {
    const { createAnalyticsClient } = require("./init");
    const client1 = await createAnalyticsClient(opts);
    const client2 = await createAnalyticsClient(opts);
    expect(client1).not.toBe(client2);
  });

  it("binds the first client to the proxy", async () => {
    // Spy before requiring the module to catch the call
    const setRealClientSpy = jest.fn();
    jest.doMock("./proxy/proxyClient", () => ({
      setRealClient: setRealClientSpy,
      proxyClient: {},
    }));
    const { createAnalyticsClient } = require("./init");
    await createAnalyticsClient(opts);
    expect(setRealClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({ track: expect.any(Function) })
    );
  });
});

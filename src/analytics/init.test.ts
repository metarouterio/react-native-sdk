// Set up mocks before importing the module
jest.mock("./proxy/proxyClient", () => ({
  proxyClient: {
    track: jest.fn(),
    identify: jest.fn(),
    group: jest.fn(),
    screen: jest.fn(),
    alias: jest.fn(),
    flush: jest.fn(),
    cleanup: jest.fn(),
  },
  setRealClient: jest.fn(),
}));

// Mock fetch globally
global.fetch = jest.fn(() => Promise.resolve({ ok: true })) as any;

// Now import after mocks are set up
import { initAnalytics, getAnalyticsClient, resetAnalytics } from "./init";
import type { InitOptions } from "./types";
import { setRealClient } from "./proxy/proxyClient";

const opts: InitOptions = {
  ingestionHost: "https://example.com",
  writeKey: "test_write_key",
  flushInterval: 5000,
};

describe("initAnalytics()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up after each test
    await resetAnalytics();
  });

  it("initializes and returns a functional analytics client", async () => {
    const client = await initAnalytics(opts);
    expect(client.track).toBeDefined();
    expect(client.flush).toBeDefined();
    expect(client.identify).toBeDefined();
    expect(client.group).toBeDefined();
    expect(client.screen).toBeDefined();
    expect(client.alias).toBeDefined();
    expect(client.cleanup).toBeDefined();
  });

  it("returns the same client on multiple init calls", async () => {
    const client1 = await initAnalytics(opts);
    const client2 = await initAnalytics(opts);
    expect(client1).toBe(client2);
  });

  it("calls setRealClient once initialized", async () => {
    await initAnalytics(opts);
    expect(setRealClient).toHaveBeenCalledTimes(1);
    expect(setRealClient).toHaveBeenCalledWith(
      expect.objectContaining({
        track: expect.any(Function),
      })
    );
  });
});

describe("getAnalyticsClient()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await resetAnalytics();
  });

  it("returns the proxy client if not initialized", () => {
    const client = getAnalyticsClient();
    expect(client.track).toBeDefined();
    expect(client.flush).toBeDefined();
  });
});

describe("resetAnalytics()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clears the client and state", async () => {
    const client1 = await initAnalytics(opts);
    await resetAnalytics();
    const client2 = await initAnalytics(opts);
    // Should be different instances after reset
    expect(client1).not.toBe(client2);
  });

  it("calls setRealClient(null) on reset", async () => {
    await initAnalytics(opts);
    await resetAnalytics();
    expect(setRealClient).toHaveBeenCalledWith(null);
  });
});

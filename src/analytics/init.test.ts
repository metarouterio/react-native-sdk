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
    jest.useRealTimers();
    jest.unmock("./proxy/proxyClient"); //
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

  it("returns the same proxy (rebound under the hood)", async () => {
    const { createAnalyticsClient } = require("./init");
    const client1 = await createAnalyticsClient(opts);
    const client2 = await createAnalyticsClient(opts);
    expect(client1).toBe(client2); // proxy surface is stable
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(setRealClientSpy).toHaveBeenCalledWith(
      expect.objectContaining({ track: expect.any(Function) })
    );
  });

  it("coalesces concurrent init into one instance", async () => {
    jest.isolateModules(() => {
      const actorCalls: any[] = [];

      jest.doMock("./MetaRouterAnalyticsClient", () => {
        return {
          MetaRouterAnalyticsClient: class {
            constructor(...args: any[]) {
              actorCalls.push(args);
            }
            init = jest.fn(async () => {}); // pretend it succeeds
            track = jest.fn();
            identify = jest.fn();
            group = jest.fn();
            screen = jest.fn();
            page = jest.fn();
            alias = jest.fn();
            enableDebugLogging = jest.fn();
            getDebugInfo = jest.fn();
            flush = jest.fn();
            reset = jest.fn();
          },
        };
      });

      const { createAnalyticsClient } = require("./init");

      // Fire multiple concurrent calls in the same tick
      return Promise.all([
        createAnalyticsClient(opts),
        createAnalyticsClient(opts),
        createAnalyticsClient(opts),
      ]).then(() => {
        expect(actorCalls.length).toBe(1); // only one `new`
      });
    });
  });

  it("buffers pre-init events and forwards after bind", async () => {
    jest.useFakeTimers();
    jest.isolateModules(async () => {
      const realTrack = jest.fn();
      jest.doMock("./MetaRouterAnalyticsClient", () => ({
        MetaRouterAnalyticsClient: class {
          init = jest.fn(async () => {});
          track = realTrack;
          identify = jest.fn();
          group = jest.fn();
          screen = jest.fn();
          page = jest.fn();
          alias = jest.fn();
          enableDebugLogging = jest.fn();
          getDebugInfo = jest.fn();
          flush = jest.fn();
          reset = jest.fn();
        },
      }));

      const { createAnalyticsClient } = require("./init");
      const client = createAnalyticsClient(opts);

      // Queue before bind completes
      client.track("pre-init", { a: 1 });

      // Let init microtask complete and binding happen
      await Promise.resolve();
      jest.runOnlyPendingTimers();

      expect(realTrack).toHaveBeenCalledWith("pre-init", { a: 1 });
    });
  });

  it("supports reconfiguration after reset with new maxQueueEvents", async () => {
    // Note: This test documents the proper pattern:
    // 1. await reset() before reconfiguring
    // 2. The warning added in createAnalyticsClient catches forgotten awaits

    const { createAnalyticsClient } = require("./init");

    // First client with maxQueueEvents: 1500
    const client1 = createAnalyticsClient({
      ...opts,
      maxQueueEvents: 1500,
    });

    // Wait for init to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    let debug1 = await client1.getDebugInfo();
    expect(debug1?.maxQueueEvents).toBe(1500);

    // Properly await reset before reconfiguring
    await client1.reset();

    // Create new client with maxQueueEvents: 2000
    const client2 = createAnalyticsClient({
      ...opts,
      maxQueueEvents: 2000,
    });

    // Wait for new init to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const debug2 = await client2.getDebugInfo();
    expect(debug2?.maxQueueEvents).toBe(2000);
  });

  it("warns if reconfiguration attempted without awaiting reset", async () => {
    const { createAnalyticsClient } = require("./init");
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // First client with maxQueueEvents: 1500
    const client1 = createAnalyticsClient({
      ...opts,
      maxQueueEvents: 1500,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Reset WITHOUT awaiting
    client1.reset(); // ❌ Not awaited!

    // Immediately try to create with new config
    const client2 = createAnalyticsClient({
      ...opts,
      maxQueueEvents: 2000,
    });

    // Should warn about config change
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[MetaRouter] Config changed but client not reset')
    );

    warnSpy.mockRestore();
  });
});

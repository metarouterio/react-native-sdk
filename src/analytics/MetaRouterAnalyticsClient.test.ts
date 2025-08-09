import * as retryMod from "./utils/retry";

import { MetaRouterAnalyticsClient } from "./MetaRouterAnalyticsClient";
import type { InitOptions } from "./types";
import { AppState } from "react-native";

const mockAddEventListener = jest.fn();
jest
  .spyOn(AppState, "addEventListener")
  .mockImplementation(mockAddEventListener);

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

describe("MetaRouterAnalyticsClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default fetch resolves OK; override per-test with mockResolvedValueOnce
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });
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

  it("throws an error if writeKey is not provided", () => {
    expect(
      () =>
        new MetaRouterAnalyticsClient({
          ingestionHost: "https://example.com",
          writeKey: "",
        })
    ).toThrow(
      "MetaRouterAnalyticsClient initialization failed: `writeKey` is required and must be a non-empty string."
    );
  });

  it("throws an error if ingestionHost is not a valid URL", () => {
    expect(
      () =>
        new MetaRouterAnalyticsClient({
          writeKey: "test_write_key",
          ingestionHost: "not-a-url",
        })
    ).toThrow(
      "MetaRouterAnalyticsClient initialization failed: `ingestionHost` must be a valid URL and not end in a slash."
    );
  });

  it("adds a track event to the queue", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("Product Viewed", { sku: "123" });

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "track",
      event: "Product Viewed",
      properties: { sku: "123" },
    });
  });

  it("adds identify event with userId", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.identify("user-123", { plan: "pro" });

    expect(client["queue"][0]).toMatchObject({
      type: "identify",
      userId: "user-123",
      traits: { plan: "pro" },
    });
  });

  it("flushes queued events to the endpoint", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("Test Event");

    // Wait for initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.flush();

    expect(fetch).toHaveBeenCalledWith(
      `${opts.ingestionHost}/v1/batch`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: expect.stringContaining("Test Event"),
      })
    );
  });

  it("clears the queue after successful flush", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("Flush Test");
    expect(client["queue"]).toHaveLength(1);

    // Wait for initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.flush();
    expect(client["queue"]).toHaveLength(0);
  });

  it("re-queues events on flush failure", async () => {
    jest
      .spyOn(retryMod, "retryWithBackoff")
      .mockImplementationOnce(async (fn: any) => {
        await fn();
        throw new Error("fail");
      });

    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
    });

    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("Event Retry");
    await expect(client.flush()).rejects.toBeTruthy();
    expect(client["queue"]).toHaveLength(1);

    expect(client["queue"]).toHaveLength(1);
  });

  it("cleans up interval and queue", () => {
    const client = new MetaRouterAnalyticsClient(opts);
    client.track("Will be removed");
    client.reset();

    expect(client["queue"]).toHaveLength(0);
    expect(client["flushTimer"]).toBeNull();
  });

  it("adds userId to subsequent events after identify()", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.identify("user-999");
    client.track("Event with identity");

    expect(client["queue"][1].userId).toBe("user-999");
  });

  it("adds groupId to subsequent events after group()", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.group("group-123");
    client.track("Event with group");

    expect(client["queue"][1].groupId).toBe("group-123");
  });

  it("flushes when app goes to background", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("Lifecycle Event");

    // Wait for initialization to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockAddEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
    const handler = mockAddEventListener.mock.calls[0][1];
    handler("background"); // simulate transition

    await new Promise((resolve) => setTimeout(resolve, 10)); // allow flush to run
    expect(fetch).toHaveBeenCalled();
  });
});

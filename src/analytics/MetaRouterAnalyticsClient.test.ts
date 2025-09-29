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

  // Retry and backoff behaviors are covered in dispatcher tests

  it("cleans up interval and queue", () => {
    const client = new MetaRouterAnalyticsClient(opts);
    client.track("Will be removed");
    client.reset();

    expect(client["queue"]).toHaveLength(0);
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

  // Singleflight flush behavior is covered by proxy and dispatcher tests

  // Batching order and size are covered in dispatcher tests

  it("skips flush when anonymousId is missing", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client["identityManager"].getAnonymousId = () => ""; // force missing
    client.track("e");

    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not requeue if reset happens during flush", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    // seed a few
    for (let i = 0; i < 5; i++) client.track(`e${i}`);

    // Make fetch fail so we hit catch
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: "err" });

    const flushP = client.flush(); // starts, will fail
    const resetP = client.reset(); // reset during in-flight

    await Promise.allSettled([flushP, resetP]);
    expect(client["queue"]).toHaveLength(0); // no requeue post-reset
  });

  // Auto-flush at threshold is covered in dispatcher tests

  it("init is idempotent: single Identity init and single interval", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    const initSpy = jest
      .spyOn(client["identityManager"], "init")
      .mockResolvedValue();

    await Promise.all([client.init(), client.init()]);
    expect(initSpy).toHaveBeenCalledTimes(1);

    const startSpy = jest.spyOn(client as any, "startFlushLoop");
    await client.init();
    expect(startSpy).toHaveBeenCalledTimes(0); // no second start
  });

  it("flushes once on active -> background transition", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();
    client.track("L");

    const handler = (AppState.addEventListener as jest.Mock).mock.calls[0][1];
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 });

    // initial state is whatever RN reports; simulate active->background edge
    client["appState"] = "active";
    handler("background");

    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects ingestionHost that ends with a slash", () => {
    expect(
      () =>
        new MetaRouterAnalyticsClient({
          ingestionHost: "https://example.com/",
          writeKey: "k",
        })
    ).toThrow(
      "MetaRouterAnalyticsClient initialization failed: `ingestionHost` must be a valid URL and not end in a slash."
    );
  });

  it("enforces maxQueueEvents by dropping oldest and preserves order", async () => {
    // Use a small cap so we don't trigger the 20-item auto-flush
    const client = new MetaRouterAnalyticsClient({
      ...opts,
      flushIntervalSeconds: 3600, // keep background loop quiet
      maxQueueEvents: 10,
    });

    await client.init();

    // Belt & suspenders: ensure dispatcher won't auto-flush in this test
    jest.spyOn(client as any, "flush").mockResolvedValue(undefined);
    // Also raise the dispatcher's threshold defensively (private access at runtime)
    (client as any).dispatcher &&
      ((client as any).dispatcher["opts"].autoFlushThreshold = 9999);

    // Seed one and capture its id so we can prove it gets dropped
    client.track("seed0");
    const firstId = (client as any).queue[0].messageId;

    // Add 15 more => total attempted = 16, cap = 10 => drop 6 oldest
    for (let i = 1; i <= 15; i++) {
      client.track(`e${i}`);
    }

    // Queue should be capped
    expect((client as any).queue.length).toBe(10);

    // The very first event should have been dropped
    expect(
      (client as any).queue.find((e: any) => e.messageId === firstId)
    ).toBeUndefined();

    // Ordering should be preserved for the tail: remaining should be e6..e15
    const names = (client as any).queue.map((e: any) => e.event);
    expect(names[0]).toBe("e6");
    expect(names[names.length - 1]).toBe("e15");

    // No network calls needed for this test
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts track with empty payload", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();

    client.track("Event Without Props");

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "track",
      event: "Event Without Props",
    });
    expect(client["queue"][0].properties).toBeUndefined();
  });

  it("accepts screen with empty payload", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();

    client.screen("Home");

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "screen",
      event: "Home",
    });
    expect(client["queue"][0].properties).toBeUndefined();
  });

  it("accepts page with empty payload", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();

    client.page("Settings");

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "page",
      event: "Settings",
    });
    expect(client["queue"][0].properties).toBeUndefined();
  });

  it("accepts identify with empty traits", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();

    client.identify("user-empty-traits");

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "identify",
      userId: "user-empty-traits",
    });
    expect(client["queue"][0].traits).toBeUndefined();
  });

  it("accepts group with empty traits", async () => {
    const client = new MetaRouterAnalyticsClient(opts);
    await client.init();

    client.group("group-empty-traits");

    expect(client["queue"]).toHaveLength(1);
    expect(client["queue"][0]).toMatchObject({
      type: "group",
      groupId: "group-empty-traits",
    });
    expect(client["queue"][0].traits).toBeUndefined();
  });
});

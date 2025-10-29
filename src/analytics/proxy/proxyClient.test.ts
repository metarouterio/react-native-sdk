import { proxyClient, setRealClient } from "./proxyClient";
import type { AnalyticsInterface } from "../types";

describe("proxyClient", () => {
  let mockClient: jest.Mocked<AnalyticsInterface>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      track: jest.fn(),
      identify: jest.fn(),
      group: jest.fn(),
      screen: jest.fn(),
      page: jest.fn(),
      alias: jest.fn(),
      setAdvertisingId: jest.fn().mockResolvedValue(undefined),
      clearAdvertisingId: jest.fn().mockResolvedValue(undefined),
      setTracing: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
      enableDebugLogging: jest.fn(),
      getDebugInfo: jest.fn().mockResolvedValue({ ok: true }),
    };
    const { setRealClient } = require("./proxyClient");
    setRealClient(null, { dropPending: true }); // clear state between tests
  });

  it("queues method calls before client is set", () => {
    proxyClient.track("Event A", { foo: "bar" });
    proxyClient.identify("user-123", { email: "test@example.com" });

    expect(mockClient.track).not.toHaveBeenCalled();
    expect(mockClient.identify).not.toHaveBeenCalled();

    setRealClient(mockClient);

    expect(mockClient.track).toHaveBeenCalledWith("Event A", { foo: "bar" });
    expect(mockClient.identify).toHaveBeenCalledWith("user-123", {
      email: "test@example.com",
    });
  });

  it("forwards method calls immediately after client is set", () => {
    setRealClient(mockClient);

    proxyClient.track("Event B", { foo: "baz" });
    proxyClient.flush();

    expect(mockClient.track).toHaveBeenCalledWith("Event B", { foo: "baz" });
    expect(mockClient.flush).toHaveBeenCalled();
  });

  it("does nothing if realClient is reset to null", () => {
    setRealClient(mockClient);
    setRealClient(null);

    proxyClient.track("Event C");
    expect(mockClient.track).not.toHaveBeenCalled();
  });

  it("logs a warning if the pending call queue exceeds 100", () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 21; i++) {
      proxyClient.track(`Event ${i}`);
    }
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[MetaRouter] Oldest call dropped (queue cap 20)")
    );
  });

  it("replays queued calls FIFO", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");

    proxyClient.track("A");
    proxyClient.track("B");
    proxyClient.track("C");

    setRealClient(mockClient);

    expect(mockClient.track.mock.calls.map(([e]) => e)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("coalesces concurrent flush calls into one in-flight promise", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    setRealClient(mockClient);

    // Hold the resolver to keep flush pending
    let resolveReal!: () => void;
    mockClient.flush.mockReturnValue(
      new Promise<void>((r) => (resolveReal = r))
    );

    const p1 = proxyClient.flush();
    const p2 = proxyClient.flush();

    expect(p1).toBe(p2); // unified promise
    expect(mockClient.flush).toHaveBeenCalledTimes(1);

    resolveReal();
    await expect(p1).resolves.toBeUndefined();
  });

  it("pre-bind flush resolves after bind + real flush", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");

    const p = proxyClient.flush(); // queued promise

    let resolveReal!: () => void;
    mockClient.flush.mockReturnValue(
      new Promise<void>((r) => (resolveReal = r))
    );
    setRealClient(mockClient); // drain -> starts flush singleflight

    // Still pending until real flush resolves
    let done = false;
    p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);

    resolveReal();
    await expect(p).resolves.toBeUndefined();
  });

  it("pre-bind reset resolves immediately and does not queue", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    await expect(proxyClient.reset()).resolves.toBeUndefined();
    setRealClient(mockClient);
    expect(mockClient.reset).not.toHaveBeenCalled();
  });

  it("getDebugInfo queues pre-bind and resolves after real client is bound", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");

    // Call getDebugInfo before client is bound - should queue and wait
    const preBindPromise = proxyClient.getDebugInfo();

    // Bind the real client
    mockClient.getDebugInfo.mockResolvedValue({ maxQueueEvents: 2000, lifecycle: 'ready' });
    setRealClient(mockClient);

    // Now the queued call should resolve with real client data
    const result = await preBindPromise;
    expect(result).toEqual({ maxQueueEvents: 2000, lifecycle: 'ready' });
    expect(mockClient.getDebugInfo).toHaveBeenCalled();

    // Post-bind calls work immediately
    mockClient.getDebugInfo.mockResolvedValue({ ok: true });
    const post = await proxyClient.getDebugInfo();
    expect(post).toEqual({ ok: true });
  });

  it("on overflow, drops oldest queued async and rejects its promise", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const p = proxyClient.flush();
      p.catch(() => {});
      promises.push(p);
    }

    // This 21st call causes the oldest (promises[0]) to be dropped/rejected.
    const p21 = proxyClient.flush();
    p21.catch(() => {}); // also guard just in case

    await expect(promises[0]).rejects.toThrow("Dropped oldest call");

    // Clean up the rest so they don't hang (no bind happened)
    setRealClient(null, { dropPending: true });

    expect(console.warn).toHaveBeenCalled();
  });

  it("dropPending rejects queued async calls", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    const p = proxyClient.flush(); // queued
    setRealClient(null, { dropPending: true });
    await expect(p).rejects.toThrow("Proxy dropped before bind");
  });

  it("swallows replay errors and continues", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    proxyClient.track("ok");
    // Force an error by binding a client that throws in track
    mockClient.track.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    setRealClient(mockClient);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("replay error:"),
      expect.any(Error)
    );
    // subsequent calls still work
    proxyClient.track("after");
    expect(mockClient.track).toHaveBeenCalledWith("after", undefined);
  });

  it("allows new flush after unbind resets singleflight", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    setRealClient(mockClient);

    let resolveFirst!: () => void;
    mockClient.flush.mockReturnValueOnce(
      new Promise<void>((r) => (resolveFirst = r))
    );
    const p1 = proxyClient.flush();
    setRealClient(null, { dropPending: true }); // reset coalescer
    resolveFirst(); // settle the old promise (shouldn’t affect new state)

    setRealClient(mockClient);
    mockClient.flush.mockResolvedValueOnce(undefined);
    const p2 = proxyClient.flush();
    await expect(p2).resolves.toBeUndefined();
    expect(mockClient.flush).toHaveBeenCalledTimes(2);
  });

  it("forwards all methods post-bind", async () => {
    const { proxyClient, setRealClient } = require("./proxyClient");
    setRealClient(mockClient);

    proxyClient.track("e", { p: 1 });
    proxyClient.identify("u", { plan: "pro" });
    proxyClient.group("g", { role: "admin" });
    proxyClient.screen("S", { i: 2 });
    proxyClient.page("P", { j: 3 });
    proxyClient.alias("u2");
    proxyClient.enableDebugLogging();
    await proxyClient.flush();
    await proxyClient.reset();
    await proxyClient.getDebugInfo();

    expect(mockClient.track).toHaveBeenCalledWith("e", { p: 1 });
    expect(mockClient.identify).toHaveBeenCalledWith("u", { plan: "pro" });
    expect(mockClient.group).toHaveBeenCalledWith("g", { role: "admin" });
    expect(mockClient.screen).toHaveBeenCalledWith("S", { i: 2 });
    expect(mockClient.page).toHaveBeenCalledWith("P", { j: 3 });
    expect(mockClient.alias).toHaveBeenCalledWith("u2");
    expect(mockClient.enableDebugLogging).toHaveBeenCalled();
    expect(mockClient.flush).toHaveBeenCalled();
    expect(mockClient.reset).toHaveBeenCalled();
    expect(mockClient.getDebugInfo).toHaveBeenCalled();
  });
});

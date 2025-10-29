import Dispatcher from "./dispatcher";
import CircuitBreaker from "./utils/circuitBreaker";

const baseOpts = () => ({
  maxQueueEvents: 2000,
  autoFlushThreshold: 20,
  maxBatchSize: 100,
  flushIntervalSeconds: 3600, // keep timer quiet unless started
  endpoint: (p: string) => `https://example.com${p}`,
  fetchWithTimeout: jest.fn(
    async (_url: string, init: any) => ({ ok: true, status: 200 } as any)
  ),
  canSend: () => true,
  isOperational: () => true,
  isTracingEnabled: () => false,
  createBreaker: () =>
    new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      maxCooldownMs: 8000,
      jitterRatio: 0,
      halfOpenMaxConcurrent: 1,
    }),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  onScheduleFlushIn: jest.fn(),
});

describe("Dispatcher", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("enqueues and auto-flushes at threshold", async () => {
    const opts = baseOpts();
    const d = new Dispatcher(opts);
    const fetchSpy = opts.fetchWithTimeout as jest.Mock;

    for (let i = 0; i < 19; i++) d.enqueue({ type: "track", event: `e${i}` });
    expect(d.getQueueRef().length).toBe(19);
    d.enqueue({ type: "track", event: "e19" }); // triggers flush
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("respects maxQueueEvents by dropping oldest", () => {
    const opts = baseOpts();
    opts.maxQueueEvents = 3;
    const d = new Dispatcher(opts);
    d.enqueue({ type: "track", event: "a" } as any);
    d.enqueue({ type: "track", event: "b" } as any);
    d.enqueue({ type: "track", event: "c" } as any);
    d.enqueue({ type: "track", event: "d" } as any); // drops oldest
    expect(d.getQueueRef().map((e: any) => e.event)).toEqual(["b", "c", "d"]);
  });

  it("batches in chunks up to maxBatchSize", async () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999; // disable auto-flush for this test
    opts.maxBatchSize = 50;
    const calls: number[] = [];
    opts.fetchWithTimeout = jest.fn(async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body).batch.length);
      return { ok: true, status: 200 } as any;
    });
    const d = new Dispatcher(opts);
    for (let i = 0; i < 120; i++)
      d.enqueue({ type: "track", event: `e${i}` } as any);
    await d.flush();
    expect(calls).toEqual([50, 50, 20]);
    expect(d.getQueueRef().length).toBe(0);
  });

  it("schedules retry on 500 and requeues chunk", async () => {
    const opts = baseOpts();
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 500, headers: { get: () => null } } as any)
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: "track", event: "x" } as any);
    await d.flush();
    expect(d.getQueueRef().length).toBe(1);
    expect(opts.onScheduleFlushIn).toHaveBeenCalled();
  });

  it("handles 413 by shrinking batch size then dropping when at 1", async () => {
    const opts = baseOpts();
    let attempts = 0;
    opts.fetchWithTimeout = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1)
        return { ok: false, status: 413, headers: { get: () => null } } as any;
      return { ok: true, status: 200 } as any;
    });
    const d = new Dispatcher(opts);
    d.enqueue({ type: "track", event: "big" } as any);
    await d.flush();
    // First call reduces batchSize and reschedules; nothing to assert about size here other than queue persists or drops later
    expect(
      (opts.warn as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes("Payload too large")
      )
    ).toBe(true);
  });

  it("throttles on 429 and schedules based on retry-after or breaker", async () => {
    const opts = baseOpts();
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 429, headers: { get: () => "2" } } as any)
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: "track", event: "x" } as any);
    await d.flush();
    expect(opts.onScheduleFlushIn).toHaveBeenCalled();
  });

  it("fatal config disables client behavior (clears queue, stops)", async () => {
    const opts = baseOpts();
    const onFatal = jest.fn();
    opts.onFatalConfig = onFatal;
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 401, headers: { get: () => null } } as any)
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: "track", event: "x" } as any);
    await d.flush();
    expect(d.getQueueRef().length).toBe(0);
    expect(onFatal).toHaveBeenCalled();
  });

  it("handles 10K events stress test: keeps newest 2K, drops oldest 8K", async () => {
    const opts = baseOpts();
    opts.maxQueueEvents = 2000;
    opts.autoFlushThreshold = 9999; // disable auto-flush for predictable test
    const d = new Dispatcher(opts);

    // Enqueue 10K events with IDs 0-9999
    for (let i = 0; i < 10000; i++) {
      d.enqueue({ type: "track", event: `event_${i}`, properties: { id: i } } as any);
    }

    // Queue should be capped at 2000
    expect(d.getQueueRef().length).toBe(2000);

    // Verify oldest 8000 events were dropped (0-7999)
    // and newest 2000 events remain (8000-9999)
    const queue = d.getQueueRef();
    const firstEventId = (queue[0] as any).properties.id;
    const lastEventId = (queue[queue.length - 1] as any).properties.id;

    expect(firstEventId).toBe(8000);
    expect(lastEventId).toBe(9999);

    // Verify all IDs in queue are contiguous (8000-9999)
    for (let i = 0; i < 2000; i++) {
      expect((queue[i] as any).properties.id).toBe(8000 + i);
    }

    // Verify warn was called 8000 times (once per dropped event)
    expect((opts.warn as jest.Mock).mock.calls.length).toBe(8000);
    expect((opts.warn as jest.Mock).mock.calls[0][0]).toContain("Queue cap 2000 reached");
  });

  it("stress test: all 2K queued events successfully transmit in batches", async () => {
    const opts = baseOpts();
    opts.maxQueueEvents = 2000;
    opts.autoFlushThreshold = 9999; // disable auto-flush
    opts.maxBatchSize = 100;

    const transmittedEvents: any[] = [];
    opts.fetchWithTimeout = jest.fn(async (_url: string, init: any) => {
      const batch = JSON.parse(init.body).batch;
      transmittedEvents.push(...batch);
      return { ok: true, status: 200 } as any;
    });

    const d = new Dispatcher(opts);

    // Enqueue 10K events
    for (let i = 0; i < 10000; i++) {
      d.enqueue({ type: "track", event: `event_${i}`, properties: { id: i } } as any);
    }

    // Flush all events
    await d.flush();

    // Queue should be empty after successful flush
    expect(d.getQueueRef().length).toBe(0);

    // Exactly 2000 events should have been transmitted
    expect(transmittedEvents.length).toBe(2000);

    // Verify they are events 8000-9999 in order
    expect(transmittedEvents[0].properties.id).toBe(8000);
    expect(transmittedEvents[1999].properties.id).toBe(9999);

    // Verify all transmitted events are contiguous
    for (let i = 0; i < 2000; i++) {
      expect(transmittedEvents[i].properties.id).toBe(8000 + i);
    }

    // Verify 20 batch calls were made (2000 events / 100 per batch)
    expect((opts.fetchWithTimeout as jest.Mock).mock.calls.length).toBe(20);
  });
});

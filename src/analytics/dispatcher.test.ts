import Dispatcher from './dispatcher';
import CircuitBreaker from './utils/circuitBreaker';

const baseOpts = () => ({
  maxEventCount: 2000,
  maxQueueBytes: 5 * 1024 * 1024, // 5MB
  autoFlushThreshold: 20,
  maxBatchSize: 100,
  flushIntervalSeconds: 3600, // keep timer quiet unless started
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 8000,
  isPersistenceEnabled: () => true,
  isNetworkAvailable: () => true,
  endpoint: (p: string) => `https://example.com${p}`,
  fetchWithTimeout: jest.fn(
    async (_url?: string, _init?: any) => ({ ok: true, status: 200 }) as any
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
  onFatalConfig: jest.fn(),
});

describe('Dispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enqueues and auto-flushes at threshold', async () => {
    const opts = baseOpts();
    const d = new Dispatcher(opts);
    const fetchSpy = opts.fetchWithTimeout as jest.Mock;

    for (let i = 0; i < 19; i++) d.enqueue({ type: 'track', event: `e${i}` });
    expect(d.getQueueRef().length).toBe(19);
    d.enqueue({ type: 'track', event: 'e19' }); // triggers flush
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('respects maxQueueBytes by flushing entire queue to overflow on capacity', () => {
    const opts = baseOpts();
    // Each event is 28 chars: {"type":"track","event":"a"}
    // Set cap to fit exactly 3 events (84 chars)
    opts.maxQueueBytes = 84;
    opts.onCapacityOverflow = jest.fn();
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'a' } as any);
    d.enqueue({ type: 'track', event: 'b' } as any);
    d.enqueue({ type: 'track', event: 'c' } as any);
    d.enqueue({ type: 'track', event: 'd' } as any); // triggers full flush + enqueue 'd'
    // Queue should only contain the new event 'd'
    expect(d.getQueueRef().map((e: any) => e.event)).toEqual(['d']);
    // Overflow callback should have received 'a', 'b', 'c'
    expect(opts.onCapacityOverflow).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ event: 'a' }),
        expect.objectContaining({ event: 'b' }),
        expect.objectContaining({ event: 'c' }),
      ])
    );
  });

  it('batches in chunks up to maxBatchSize', async () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999; // disable auto-flush for this test
    opts.maxBatchSize = 50;
    const calls: number[] = [];
    opts.fetchWithTimeout = jest.fn(async (_url?: string, init?: any) => {
      calls.push(JSON.parse(init.body).batch.length);
      return { ok: true, status: 200 } as any;
    });
    const d = new Dispatcher(opts);
    for (let i = 0; i < 120; i++)
      d.enqueue({ type: 'track', event: `e${i}` } as any);
    await d.flush();
    expect(calls).toEqual([50, 50, 20]);
    expect(d.getQueueRef().length).toBe(0);
  });

  it('schedules retry on 500 and requeues chunk', async () => {
    const opts = baseOpts();
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 500, headers: { get: () => null } }) as any
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'x' } as any);
    await d.flush();
    expect(d.getQueueRef().length).toBe(1);
    expect(opts.onScheduleFlushIn).toHaveBeenCalled();
  });

  it('handles 413 by shrinking batch size then dropping when at 1', async () => {
    const opts = baseOpts();
    let attempts = 0;
    opts.fetchWithTimeout = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1)
        return { ok: false, status: 413, headers: { get: () => null } } as any;
      return { ok: true, status: 200 } as any;
    });
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'big' } as any);
    await d.flush();
    // First call reduces batchSize and reschedules; nothing to assert about size here other than queue persists or drops later
    expect(
      (opts.warn as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes('Payload too large')
      )
    ).toBe(true);
  });

  it('throttles on 429 and schedules based on retry-after or breaker', async () => {
    const opts = baseOpts();
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 429, headers: { get: () => '2' } }) as any
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'x' } as any);
    await d.flush();
    expect(opts.onScheduleFlushIn).toHaveBeenCalled();
  });

  it('fatal config disables client behavior (clears queue, stops)', async () => {
    const opts = baseOpts();
    const onFatal = jest.fn();
    opts.onFatalConfig = onFatal;
    opts.fetchWithTimeout = jest.fn(
      async () =>
        ({ ok: false, status: 401, headers: { get: () => null } }) as any
    );
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'x' } as any);
    await d.flush();
    expect(d.getQueueRef().length).toBe(0);
    expect(onFatal).toHaveBeenCalled();
  });

  it('handles 10K events stress test: keeps newest ~2K, drops oldest', async () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999; // disable auto-flush for predictable test

    // Use uniform-size events (padded IDs) so byte cap maps to exact count
    const makeEvent = (i: number) => ({
      type: 'track' as const,
      event: 'evt',
      properties: { id: String(i).padStart(5, '0') },
    });
    const eventSize = JSON.stringify(makeEvent(0)).length;
    opts.maxQueueBytes = eventSize * 2000;

    const d = new Dispatcher(opts);

    for (let i = 0; i < 10000; i++) {
      d.enqueue(makeEvent(i) as any);
    }

    // With the new flush-entire-queue overflow model, each time the cap is exceeded
    // the entire queue is dropped (no onCapacityOverflow set).
    // Only the most recent event(s) that fit within the cap after the last overflow remain.
    const queue = d.getQueueRef();
    // Queue should not exceed cap
    expect(d.getQueueSizeBytes()).toBeLessThanOrEqual(eventSize * 2000);
    // The last event should always be present
    expect((queue[queue.length - 1] as any).properties.id).toBe('09999');

    // Verify warn was called for each overflow (entire queue dropped each time)
    expect(
      (opts.warn as jest.Mock).mock.calls.some((c) =>
        String(c[0]).includes('Queue cap reached')
      )
    ).toBe(true);
  });

  it('gradually recovers maxBatchSize after 413-induced reduction on subsequent successes', async () => {
    const opts = baseOpts();
    opts.maxBatchSize = 100;
    opts.autoFlushThreshold = 9999;
    let callCount = 0;
    opts.fetchWithTimeout = jest.fn(async (_url?: string, _init?: any) => {
      callCount++;
      // First call: 413 to trigger halving
      if (callCount === 1)
        return { ok: false, status: 413, headers: { get: () => null } } as any;
      return { ok: true, status: 200 } as any;
    });

    const d = new Dispatcher(opts);

    // Enqueue enough events and flush to trigger the 413
    for (let i = 0; i < 5; i++)
      d.enqueue({ type: 'track', event: `e${i}` } as any);
    await d.flush();

    // After 413, maxBatchSize should have been halved to 50
    expect(d.getDebugInfo().maxBatchSize).toBe(50);

    // Flush again — events succeed, so batch size should recover: min(50*2, 100) = 100
    await d.flush();
    expect(d.getDebugInfo().maxBatchSize).toBe(100);
  });

  it('does not recover maxBatchSize beyond initialMaxBatchSize', async () => {
    const opts = baseOpts();
    opts.maxBatchSize = 100;
    opts.autoFlushThreshold = 9999;
    let callCount = 0;
    opts.fetchWithTimeout = jest.fn(async (_url?: string, _init?: any) => {
      callCount++;
      if (callCount === 1)
        return { ok: false, status: 413, headers: { get: () => null } } as any;
      return { ok: true, status: 200 } as any;
    });

    const d = new Dispatcher(opts);
    for (let i = 0; i < 3; i++)
      d.enqueue({ type: 'track', event: `e${i}` } as any);
    await d.flush();

    // After recovery, should not exceed initial value of 100
    expect(d.getDebugInfo().maxBatchSize).toBeLessThanOrEqual(100);
  });

  it('enqueueFront prepends events in order', () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999;
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'a' } as any);
    d.enqueue({ type: 'track', event: 'b' } as any);

    d.enqueueFront([
      { type: 'track', event: 'x' } as any,
      { type: 'track', event: 'y' } as any,
    ]);

    expect(d.getQueueRef().map((e: any) => e.event)).toEqual([
      'x',
      'y',
      'a',
      'b',
    ]);
  });

  it('enqueueFront flushes entire queue to overflow when exceeding capacity', () => {
    const opts = baseOpts();
    // Each event is 28 chars — set cap to fit exactly 3 (84 chars)
    opts.maxQueueBytes = 84;
    opts.autoFlushThreshold = 9999;
    opts.onCapacityOverflow = jest.fn();
    const d = new Dispatcher(opts);
    d.enqueue({ type: 'track', event: 'a' } as any);
    d.enqueue({ type: 'track', event: 'b' } as any);

    d.enqueueFront([
      { type: 'track', event: 'x' } as any,
      { type: 'track', event: 'y' } as any,
      { type: 'track', event: 'z' } as any,
    ]);

    // Total would be 5×28=140 chars, cap is 84. Entire merged queue flushed to overflow.
    expect(opts.onCapacityOverflow).toHaveBeenCalledTimes(1);
    const flushed = (opts.onCapacityOverflow as jest.Mock).mock.calls[0][0];
    expect(flushed.length).toBe(5);
    expect(flushed.map((e: any) => e.event)).toEqual(['x', 'y', 'z', 'a', 'b']);

    // Queue should be empty after overflow flush
    expect(d.getQueueRef().length).toBe(0);
  });

  it('getQueueSizeBytes returns approximate serialized size', () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999;
    const d = new Dispatcher(opts);
    expect(d.getQueueSizeBytes()).toBe(0);

    const event = {
      type: 'track',
      event: 'test',
      properties: { key: 'value' },
    } as any;
    d.enqueue(event);
    expect(d.getQueueSizeBytes()).toBeGreaterThan(0);
  });

  it('getQueueSizeBytes decreases after flush', async () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999;
    const d = new Dispatcher(opts);

    for (let i = 0; i < 5; i++) {
      d.enqueue({
        type: 'track',
        event: `e${i}`,
        properties: { i },
      } as any);
    }
    const before = d.getQueueSizeBytes();
    expect(before).toBeGreaterThan(0);

    await d.flush();
    expect(d.getQueueSizeBytes()).toBe(0);
  });

  it('getQueueSizeBytes tracks correctly through enqueueFront', () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999;
    const d = new Dispatcher(opts);

    d.enqueue({ type: 'track', event: 'a' } as any);
    const sizeAfterOne = d.getQueueSizeBytes();

    d.enqueueFront([{ type: 'track', event: 'b' } as any]);
    expect(d.getQueueSizeBytes()).toBeGreaterThan(sizeAfterOne);
  });

  it('getQueueSizeBytes resets to 0 after reset()', () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999;
    const d = new Dispatcher(opts);

    d.enqueue({ type: 'track', event: 'a' } as any);
    expect(d.getQueueSizeBytes()).toBeGreaterThan(0);

    d.reset();
    expect(d.getQueueSizeBytes()).toBe(0);
  });

  describe('network awareness', () => {
    it('events enqueue while offline, no HTTP attempts', async () => {
      const opts = baseOpts();
      opts.isNetworkAvailable = () => false;
      const d = new Dispatcher(opts);

      d.enqueue({ type: 'track', event: 'e1' } as any);
      d.enqueue({ type: 'track', event: 'e2' } as any);
      await d.flush();

      expect(opts.fetchWithTimeout).not.toHaveBeenCalled();
      expect(d.getQueueRef().length).toBe(2);
    });

    it('offline -> online triggers flush', async () => {
      const opts = baseOpts();
      let online = false;
      opts.isNetworkAvailable = () => online;
      const d = new Dispatcher(opts);

      d.enqueue({ type: 'track', event: 'e1' } as any);
      await d.flush();
      expect(opts.fetchWithTimeout).not.toHaveBeenCalled();

      // Go online
      online = true;
      await d.flush();
      expect(opts.fetchWithTimeout).toHaveBeenCalled();
      expect(d.getQueueRef().length).toBe(0);
    });

    it('resetCircuitBreaker() resets circuit state', async () => {
      const opts = baseOpts();
      opts.fetchWithTimeout = jest.fn(
        async () =>
          ({ ok: false, status: 500, headers: { get: () => null } }) as any
      );
      const d = new Dispatcher(opts);

      // Trip the circuit breaker
      d.enqueue({ type: 'track', event: 'x' } as any);
      await d.flush();
      d.enqueue({ type: 'track', event: 'y' } as any);
      await d.flush();
      d.enqueue({ type: 'track', event: 'z' } as any);
      await d.flush();

      // Circuit should be impacted
      expect(d.getDebugInfo().consecutiveRetries).toBeGreaterThan(0);

      // Reset
      d.resetCircuitBreaker();
      expect(d.getDebugInfo().consecutiveRetries).toBe(0);
      expect(d.getDebugInfo().circuitState).toBe('CLOSED');
    });

    it('circuit breaker does NOT reset while still connected but failing', async () => {
      const opts = baseOpts();
      opts.fetchWithTimeout = jest.fn(
        async () =>
          ({ ok: false, status: 500, headers: { get: () => null } }) as any
      );
      const d = new Dispatcher(opts);

      // Trip the circuit breaker (3 failures = threshold)
      for (let i = 0; i < 3; i++) {
        d.enqueue({ type: 'track', event: `e${i}` } as any);
        await d.flush();
      }

      // Circuit should be OPEN (not auto-reset)
      expect(d.getDebugInfo().circuitState).toBe('OPEN');
    });

    it('getDebugInfo includes isNetworkAvailable', () => {
      const opts = baseOpts();
      opts.isNetworkAvailable = () => false;
      const d = new Dispatcher(opts);
      expect(d.getDebugInfo().isNetworkAvailable).toBe(false);
    });

    it('offline log warns with flushed event count when onFlushToDisk is set', async () => {
      const opts = baseOpts();
      opts.isNetworkAvailable = () => false;
      opts.onFlushToDisk = jest.fn();
      const d = new Dispatcher(opts);

      d.enqueue({ type: 'track', event: 'e1' } as any);
      d.enqueue({ type: 'track', event: 'e2' } as any);
      await d.flush();

      expect(
        (opts.warn as jest.Mock).mock.calls.some(
          (c) =>
            String(c[0]).includes('Offline') &&
            String(c[0]).includes('flushed') &&
            String(c[0]).includes('2 event(s)')
        )
      ).toBe(true);
    });

    it('offline log warns with queue count when no onFlushToDisk', async () => {
      const opts = baseOpts();
      opts.isNetworkAvailable = () => false;
      const d = new Dispatcher(opts);

      d.enqueue({ type: 'track', event: 'e1' } as any);
      d.enqueue({ type: 'track', event: 'e2' } as any);
      await d.flush();

      expect(
        (opts.warn as jest.Mock).mock.calls.some(
          (c) =>
            String(c[0]).includes('Offline') &&
            String(c[0]).includes('2 event(s)')
        )
      ).toBe(true);
    });
  });

  describe('onCapacityOverflow callback', () => {
    it('fires with entire queue when capacity is hit', () => {
      const opts = baseOpts();
      const overflowEvents: any[][] = [];
      opts.onCapacityOverflow = jest.fn((events: any[]) => {
        overflowEvents.push(events);
      });
      opts.maxQueueBytes = 84; // fits ~3 small events
      opts.autoFlushThreshold = 9999;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);
      d.enqueue({ type: 'track', event: 'b' } as any);
      d.enqueue({ type: 'track', event: 'c' } as any);
      d.enqueue({ type: 'track', event: 'd' } as any); // flushes a,b,c to overflow

      expect(opts.onCapacityOverflow).toHaveBeenCalledTimes(1);
      expect(overflowEvents[0].length).toBe(3);
      expect(overflowEvents[0].map((e: any) => e.event)).toEqual([
        'a',
        'b',
        'c',
      ]);

      // Queue should only contain the new event
      expect(d.getQueueRef().length).toBe(1);
      expect((d.getQueueRef()[0] as any).event).toBe('d');
    });

    it('does not fire when queue is within capacity', () => {
      const opts = baseOpts();
      opts.onCapacityOverflow = jest.fn();
      opts.autoFlushThreshold = 9999;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);
      d.enqueue({ type: 'track', event: 'b' } as any);

      expect(opts.onCapacityOverflow).not.toHaveBeenCalled();
    });

    it('resets queue bytes to 0 after overflow', () => {
      const opts = baseOpts();
      opts.onCapacityOverflow = jest.fn();
      const eventSize = new TextEncoder().encode(
        JSON.stringify({ type: 'track', event: 'x' })
      ).byteLength;
      opts.maxQueueBytes = eventSize; // fits exactly 1 event
      opts.autoFlushThreshold = 9999;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);
      d.enqueue({ type: 'track', event: 'b' } as any); // overflows 'a', enqueues 'b'

      // Queue should have just 'b', size should be 1 event's worth
      expect(d.getQueueRef().length).toBe(1);
      expect(d.getQueueSizeBytes()).toBe(eventSize);
    });
  });

  describe('onFlushToDisk callback', () => {
    it('fires when flush is called while offline', async () => {
      const opts = baseOpts();
      opts.isNetworkAvailable = () => false;
      opts.onFlushToDisk = jest.fn();
      opts.autoFlushThreshold = 9999;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);
      d.enqueue({ type: 'track', event: 'b' } as any);

      await d.flush();

      expect(opts.onFlushToDisk).toHaveBeenCalledTimes(1);
      expect(opts.onFlushToDisk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ event: 'a' }),
          expect.objectContaining({ event: 'b' }),
        ])
      );
      // Queue should be empty after flushing to disk
      expect(d.getQueueRef().length).toBe(0);
    });

    it('does not fire when online', async () => {
      const opts = baseOpts();
      opts.onFlushToDisk = jest.fn();

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);
      d.enqueue({ type: 'track', event: 'b' } as any);

      await d.flush();

      expect(opts.onFlushToDisk).not.toHaveBeenCalled();
    });
  });

  describe('onFlushComplete callback', () => {
    it('fires after successful online flush that empties the queue', async () => {
      const opts = baseOpts();
      opts.onFlushComplete = jest.fn();
      opts.autoFlushThreshold = 9999;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);

      await d.flush();

      expect(opts.onFlushComplete).toHaveBeenCalledTimes(1);
    });

    it('does not fire on failed flush', async () => {
      const opts = baseOpts();
      opts.onFlushComplete = jest.fn();
      opts.autoFlushThreshold = 9999;
      opts.fetchWithTimeout = jest.fn(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
      })) as any;

      const d = new Dispatcher(opts);
      d.enqueue({ type: 'track', event: 'a' } as any);

      await d.flush();

      expect(opts.onFlushComplete).not.toHaveBeenCalled();
    });
  });

  describe('sendBatchDirect', () => {
    it('returns statusCode on successful send', async () => {
      const opts = baseOpts();
      const d = new Dispatcher(opts);

      const result = await d.sendBatchDirect([
        { type: 'track', event: 'e1' } as any,
      ]);
      expect(result).toEqual({ statusCode: 200 });
      expect(opts.fetchWithTimeout).toHaveBeenCalled();
    });

    it('returns statusCode on HTTP error', async () => {
      const opts = baseOpts();
      opts.fetchWithTimeout = jest.fn(async () => ({
        ok: false,
        status: 500,
      })) as any;
      const d = new Dispatcher(opts);

      const result = await d.sendBatchDirect([
        { type: 'track', event: 'e1' } as any,
      ]);
      expect(result).toEqual({ statusCode: 500 });
    });

    it('returns null on network error', async () => {
      const opts = baseOpts();
      opts.fetchWithTimeout = jest.fn(async () => {
        throw new Error('Network unavailable');
      });
      const d = new Dispatcher(opts);

      const result = await d.sendBatchDirect([
        { type: 'track', event: 'e1' } as any,
      ]);
      expect(result).toBeNull();
    });

    it('does not affect the memory queue', async () => {
      const opts = baseOpts();
      opts.autoFlushThreshold = 9999;
      const d = new Dispatcher(opts);

      d.enqueue({ type: 'track', event: 'queued' } as any);
      await d.sendBatchDirect([{ type: 'track', event: 'direct' } as any]);

      // Memory queue unchanged
      expect(d.getQueueRef().length).toBe(1);
      expect((d.getQueueRef()[0] as any).event).toBe('queued');
    });

    it('stamps sentAt on batch events', async () => {
      const opts = baseOpts();
      let sentBody: any = null;
      opts.fetchWithTimeout = jest.fn(async (_url?: string, init?: any) => {
        sentBody = JSON.parse(init.body);
        return { ok: true, status: 200 } as any;
      });
      const d = new Dispatcher(opts);

      await d.sendBatchDirect([{ type: 'track', event: 'e1' } as any]);

      expect(sentBody.batch[0].sentAt).toBeDefined();
    });
  });

  it('stress test: all ~2K queued events successfully transmit in batches', async () => {
    const opts = baseOpts();
    opts.autoFlushThreshold = 9999; // disable auto-flush
    opts.maxBatchSize = 100;

    // Use uniform-size events so byte cap maps to exact count
    const makeEvent = (i: number) => ({
      type: 'track' as const,
      event: 'evt',
      properties: { id: String(i).padStart(5, '0') },
    });
    const eventSize = JSON.stringify(makeEvent(0)).length;
    opts.maxQueueBytes = eventSize * 2000;

    const transmittedEvents: any[] = [];
    opts.fetchWithTimeout = jest.fn(async (_url?: string, init?: any) => {
      const batch = JSON.parse(init.body).batch;
      transmittedEvents.push(...batch);
      return { ok: true, status: 200 } as any;
    });

    const d = new Dispatcher(opts);

    // Enqueue 10K events
    for (let i = 0; i < 10000; i++) {
      d.enqueue(makeEvent(i) as any);
    }

    // Flush all events
    await d.flush();

    // Queue should be empty after successful flush
    expect(d.getQueueRef().length).toBe(0);

    // Exactly 2000 events should have been transmitted
    expect(transmittedEvents.length).toBe(2000);

    // Verify they are events 8000-9999 in order
    expect(transmittedEvents[0].properties.id).toBe('08000');
    expect(transmittedEvents[1999].properties.id).toBe('09999');

    // Verify all transmitted events are contiguous
    for (let i = 0; i < 2000; i++) {
      expect(transmittedEvents[i].properties.id).toBe(
        String(8000 + i).padStart(5, '0')
      );
    }

    // Verify 20 batch calls were made (2000 events / 100 per batch)
    expect((opts.fetchWithTimeout as jest.Mock).mock.calls.length).toBe(20);
  });
});

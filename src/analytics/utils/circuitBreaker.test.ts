import CircuitBreaker from "./circuitBreaker";

describe("CircuitBreaker", () => {
  let nowMs: number;
  let breaker: CircuitBreaker;
  let randomSpy: jest.SpyInstance<number, []> | null;

  const makeBreaker = (
    overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}
  ) => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      maxCooldownMs: 8000,
      jitterRatio: 0,
      now: () => nowMs,
      ...overrides,
    });
  };

  const advanceTime = (ms: number) => {
    nowMs += ms;
  };

  beforeEach(() => {
    nowMs = 1_000_000;
    randomSpy = null;
  });

  afterEach(() => {
    if (randomSpy) {
      randomSpy.mockRestore();
      randomSpy = null;
    }
  });

  it("starts CLOSED and allows requests", () => {
    makeBreaker();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.nextAllowedAt()).toBe(nowMs);
    expect(breaker.remainingCooldownMs()).toBe(0);
  });

  it("trips OPEN after reaching failure threshold", () => {
    makeBreaker({ failureThreshold: 2, jitterRatio: 0 });

    // First failure does not trip yet (threshold 2)
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");

    // Second failure trips OPEN
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1000);
    expect(breaker.remainingCooldownMs()).toBe(1000);
  });

  it("moves to HALF_OPEN after cooldown and allows limited probe(s)", () => {
    makeBreaker({
      failureThreshold: 1,
      jitterRatio: 0,
      halfOpenMaxConcurrent: 1,
    });

    // Trip OPEN immediately
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    // Cooldown elapses
    advanceTime(1000);
    expect(breaker.getState()).toBe("HALF_OPEN"); // normalized

    // First probe allowed, second probe blocked until success/failure closes/reopens
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.allowRequest()).toBe(false);

    // Success while HALF_OPEN closes and resets
    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");
    expect(breaker.allowRequest()).toBe(true);
  });

  it("failed probe in HALF_OPEN reopens with exponential backoff", () => {
    makeBreaker({ failureThreshold: 1, cooldownMs: 1000, jitterRatio: 0 });

    // First open
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1000);

    // Move to HALF_OPEN
    advanceTime(1000);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.allowRequest()).toBe(true);

    // Fail probe -> re-open with doubled backoff (2x)
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.nextAllowedAt()).toBe(nowMs + 2000);
  });

  it("exponential backoff is capped at maxCooldownMs", () => {
    makeBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
      maxCooldownMs: 1000,
      jitterRatio: 0,
    });

    // Open #1 -> 500ms
    breaker.onFailure();
    expect(breaker.nextAllowedAt()).toBe(nowMs + 500);
    advanceTime(500);

    // Half-open, fail -> Open #2 -> 1000ms
    expect(breaker.allowRequest()).toBe(true);
    breaker.onFailure();
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1000);
    advanceTime(1000);

    // Half-open, fail -> Open #3 -> would be 2000ms, but capped at 1000ms
    expect(breaker.allowRequest()).toBe(true);
    breaker.onFailure();
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1000);
  });

  it("applies jitter within expected bounds", () => {
    // jitterRatio = 0.2, base = 1000
    makeBreaker({ failureThreshold: 1, cooldownMs: 1000, jitterRatio: 0.2 });

    // Force Math.random() = 1 -> +20%
    randomSpy = jest.spyOn(Math, "random").mockReturnValue(1);
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    // backoff = 1000, jitter = 200, random = 1 => backoff + 200
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1200);

    // Cooldown
    advanceTime(1200);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.allowRequest()).toBe(true);

    // Fail probe with Math.random() = 0 -> -20%, base*2 = 2000 -> 1600
    randomSpy.mockReturnValue(0);
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.nextAllowedAt()).toBe(nowMs + 1600);
  });

  it("getState normalizes OPEN to HALF_OPEN after cooldown without allowRequest()", () => {
    makeBreaker({ failureThreshold: 1, cooldownMs: 750, jitterRatio: 0 });
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    advanceTime(751);
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("respects halfOpenMaxConcurrent", () => {
    makeBreaker({
      failureThreshold: 1,
      cooldownMs: 300,
      jitterRatio: 0,
      halfOpenMaxConcurrent: 2,
    });
    breaker.onFailure();
    advanceTime(300);
    expect(breaker.getState()).toBe("HALF_OPEN");

    // Two probes allowed, third blocked
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.allowRequest()).toBe(false);

    // Close via success
    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("success resets consecutive failures and openCount after HALF_OPEN success", () => {
    makeBreaker({ failureThreshold: 2, cooldownMs: 500, jitterRatio: 0 });

    // One failure below threshold
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");

    // Success resets failure count
    breaker.onSuccess();

    // Two fresh failures should trip OPEN again only after threshold
    breaker.onFailure();
    expect(breaker.getState()).toBe("CLOSED");
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");

    // Move to HALF_OPEN and succeed -> close and reset openCount
    advanceTime(500);
    expect(breaker.getState()).toBe("HALF_OPEN");
    expect(breaker.allowRequest()).toBe(true);
    breaker.onSuccess();
    expect(breaker.getState()).toBe("CLOSED");

    // Failing again should use initial backoff (not compounded)
    // Need two failures to meet threshold (2)
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.nextAllowedAt()).toBe(nowMs + 500);
  });

  it("treats failureThreshold < 1 as 1 (normalized)", () => {
    makeBreaker({ failureThreshold: 0, cooldownMs: 400, jitterRatio: 0 });
    breaker.onFailure();
    expect(breaker.getState()).toBe("OPEN");
    expect(breaker.nextAllowedAt()).toBe(nowMs + 400);
  });
});

import { retryWithBackoff } from "./retry";

describe("retryWithBackoff()", () => {
  let mockSleep: jest.Mock;

  beforeEach(() => {
    mockSleep = jest.fn(() => Promise.resolve());
  });

  it("returns result immediately on first success", async () => {
    const fn = jest.fn().mockResolvedValue("success");
    const result = retryWithBackoff(fn, {
      retries: 5,
      baseDelayMs: 1000,
      sleep: mockSleep,
    });

    await expect(result).resolves.toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const result = retryWithBackoff(fn, {
      retries: 3,
      baseDelayMs: 1000,
      sleep: mockSleep,
    });

    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("fail"));

    const result = retryWithBackoff(fn, {
      retries: 3,
      baseDelayMs: 1000,
      sleep: mockSleep,
    });

    await expect(result).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("handles async values", async () => {
    const fn = jest.fn().mockResolvedValue({ data: 123 });

    const result = retryWithBackoff(fn, {
      retries: 5,
      baseDelayMs: 1000,
      sleep: mockSleep,
    });

    await expect(result).resolves.toEqual({ data: 123 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses retry count properly", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("fail"));

    const result = retryWithBackoff(fn, {
      retries: 2,
      baseDelayMs: 1000,
      sleep: mockSleep,
    });

    await expect(result).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });
});

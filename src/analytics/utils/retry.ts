export type BackoffOptions = {
  retries?: number; // default 5
  baseDelayMs?: number; // default 1000
  sleep?: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean; // called before each attempt and after each sleep
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const {
    retries = 5,
    baseDelayMs = 1000,
    sleep = (ms: number) => new Promise((res) => setTimeout(res, ms)),
    shouldContinue = () => true,
  } = opts;

  let attempt = 0;
  while (attempt < retries) {
    if (!shouldContinue()) throw new Error("Retry aborted by shouldContinue");

    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt === retries) throw err;

      const jitter = Math.random() * 100;
      const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;

      await sleep(delay);
      if (!shouldContinue()) throw new Error("Retry aborted by shouldContinue");
    }
  }

  // Unreachable, but TS likes a return/throw
  throw new Error("Exhausted all retries");
}

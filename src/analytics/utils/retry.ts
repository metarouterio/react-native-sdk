/**
 * Retries an asynchronous operation with exponential backoff and optional jitter.
 *
 * - Attempts to execute the provided async function up to `retries` times.
 * - Waits an exponentially increasing delay (with random jitter) between attempts.
 * - If all attempts fail, the last error is thrown.
 *
 * @template T The return type of the async function.
 * @param fn The asynchronous function to retry.
 * @param retries The maximum number of attempts (default: 5).
 * @param baseDelayMs The base delay in milliseconds for backoff (default: 1000).
 * @param sleep Optional custom sleep function (default: setTimeout-based Promise).
 * @returns A promise that resolves with the result of `fn`, or rejects after all retries fail.
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    retries = 5,
    baseDelayMs = 1000,
    sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
  ): Promise<T> {
    let attempt = 0;
  
    while (attempt < retries) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt === retries) throw err;
  
        const jitter = Math.random() * 100;
        const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;
        await sleep(delay);
      }
    }
  
    throw new Error('Exhausted all retries');
  }
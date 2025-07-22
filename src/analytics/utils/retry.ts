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
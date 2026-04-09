import type { NetworkReachability, NetworkStatus } from './NetworkReachability';

/**
 * Test double for network monitoring. Fires status changes synchronously
 * via `simulate()` — no internal timers or debounce.
 */
export class StubNetworkMonitor implements NetworkReachability {
  private callback: ((status: NetworkStatus) => void) | null = null;
  private status: NetworkStatus;

  constructor(initialStatus: NetworkStatus = 'connected') {
    this.status = initialStatus;
  }

  onStatusChange(callback: (status: NetworkStatus) => void): () => void {
    this.callback = callback;
    return () => {
      this.callback = null;
    };
  }

  stop(): void {
    this.callback = null;
  }

  /** Simulate a network transition. Only fires if status actually changes. */
  simulate(status: NetworkStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.callback?.(status);
  }
}

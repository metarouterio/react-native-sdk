import type { NetworkReachability, NetworkStatus } from './networkMonitor';

const DEBOUNCE_MS = 2_000;

/**
 * Decorator that wraps a NetworkReachability monitor and debounces online transitions.
 * Offline transitions fire immediately; online transitions only fire after
 * connectivity has been stable for 2 seconds.
 */
export class DebouncedNetworkMonitor implements NetworkReachability {
  private inner: NetworkReachability;
  private _currentStatus: NetworkStatus;
  private handler: ((status: NetworkStatus) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeInner: (() => void) | null = null;

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  constructor(inner: NetworkReachability) {
    this.inner = inner;
    this._currentStatus = inner.currentStatus;

    this.unsubscribeInner = inner.onStatusChange((rawStatus) => {
      this.handleRawStatusChange(rawStatus);
    });
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.handler = null;
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    this.inner.stop();
  }

  private handleRawStatusChange(rawStatus: NetworkStatus): void {
    if (rawStatus === 'disconnected') {
      // Offline: immediate — cancel any pending online debounce
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      if (this._currentStatus !== 'disconnected') {
        this._currentStatus = 'disconnected';
        this.handler?.('disconnected');
      }
    } else {
      // Online: debounce — wait for stability before firing
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this._currentStatus !== 'connected') {
          this._currentStatus = 'connected';
          this.handler?.('connected');
        }
      }, DEBOUNCE_MS);
    }
  }
}

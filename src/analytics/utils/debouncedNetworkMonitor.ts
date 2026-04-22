import type { NetworkReachability, NetworkStatus } from './networkMonitor';

/**
 * Wraps a {@link NetworkReachability} with asymmetric debouncing:
 * - **offline** transitions fire immediately (pause HTTP ASAP — no point
 *   burning retries on a down network).
 * - **online** transitions wait for {@link ONLINE_DEBOUNCE_MS} of stable
 *   connectivity before firing, so flaky WiFi/cellular handoffs don't
 *   trigger spurious flush attempts that immediately fail.
 *
 * A pending online debounce is cancelled if offline arrives during the wait.
 */
export class DebouncedNetworkMonitor implements NetworkReachability {
  static readonly ONLINE_DEBOUNCE_MS = 2000;

  private readonly inner: NetworkReachability;
  private handler: ((status: NetworkStatus) => void) | null = null;
  private unsubscribeInner: (() => void) | null = null;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentStatus: NetworkStatus;

  constructor(inner: NetworkReachability) {
    this.inner = inner;
    this._currentStatus = inner.currentStatus;

    this.unsubscribeInner = inner.onStatusChange((rawStatus) => {
      if (rawStatus === 'disconnected') {
        this.clearOnlineTimer();
        if (this._currentStatus !== 'disconnected') {
          this._currentStatus = 'disconnected';
          this.handler?.('disconnected');
        }
        return;
      }

      // rawStatus === 'connected': start/reset the debounce window
      this.clearOnlineTimer();
      if (this._currentStatus === 'connected') return;

      this.onlineTimer = setTimeout(() => {
        this.onlineTimer = null;
        // Guard against racing with a late offline transition.
        if (this.inner.currentStatus !== 'connected') return;
        if (this._currentStatus !== 'connected') {
          this._currentStatus = 'connected';
          this.handler?.('connected');
        }
      }, DebouncedNetworkMonitor.ONLINE_DEBOUNCE_MS);
    });
  }

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    this.clearOnlineTimer();
    this.unsubscribeInner?.();
    this.unsubscribeInner = null;
    this.handler = null;
  }

  private clearOnlineTimer(): void {
    if (this.onlineTimer) {
      clearTimeout(this.onlineTimer);
      this.onlineTimer = null;
    }
  }
}

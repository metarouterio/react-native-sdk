export type NetworkStatus = 'connected' | 'disconnected';

export interface NetworkReachability {
  /** Current connectivity snapshot */
  readonly currentStatus: NetworkStatus;
  /** Register callback for status transitions. Returns unsubscribe function. */
  onStatusChange(handler: (status: NetworkStatus) => void): () => void;
  /** Tear down monitoring */
  stop(): void;
}

export class NetworkMonitor implements NetworkReachability {
  private _currentStatus: NetworkStatus = 'connected';
  private handler: ((status: NetworkStatus) => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  constructor() {
    try {
      const { NativeModules, NativeEventEmitter } = require('react-native');
      const MetaRouterNetworkMonitor = NativeModules.MetaRouterNetworkMonitor;
      if (!MetaRouterNetworkMonitor)
        throw new Error('Native module not available');

      // Get initial state from native
      MetaRouterNetworkMonitor.getCurrentStatus()
        .then((connected: boolean) => {
          const newStatus: NetworkStatus = connected
            ? 'connected'
            : 'disconnected';
          if (newStatus !== this._currentStatus) {
            this._currentStatus = newStatus;
            this.handler?.(newStatus);
          }
        })
        .catch(() => {
          /* fallback: stay connected */
        });

      // Subscribe to native connectivity events
      const emitter = new NativeEventEmitter(MetaRouterNetworkMonitor);
      const subscription = emitter.addListener(
        'onConnectivityChange',
        (event: { isConnected: boolean }) => {
          const newStatus: NetworkStatus = event.isConnected
            ? 'connected'
            : 'disconnected';
          if (newStatus !== this._currentStatus) {
            this._currentStatus = newStatus;
            this.handler?.(newStatus);
          }
        }
      );

      this.unsubscribe = () => subscription.remove();
    } catch {
      // Native module not available — stay as always-connected (default behavior)
    }
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handler = null;
  }
}

export class StubNetworkMonitor implements NetworkReachability {
  private _currentStatus: NetworkStatus;
  private handler: ((status: NetworkStatus) => void) | null = null;

  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  constructor(initialStatus: NetworkStatus = 'connected') {
    this._currentStatus = initialStatus;
  }

  onStatusChange(handler: (status: NetworkStatus) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  stop(): void {
    this.handler = null;
  }

  /** Simulate a network transition from tests */
  simulate(status: NetworkStatus): void {
    if (status !== this._currentStatus) {
      this._currentStatus = status;
      this.handler?.(status);
    }
  }
}
